import { clsx } from 'clsx'
import { useTranslations } from 'next-intl'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { FloatPopover } from '~/components/ui/FloatPopover'
import { MusicIcon } from '~/components/ui/Icons/for-fav'
import { useKamiConfig } from '~/hooks/app/use-initial-data'
import { socketClient } from '~/socket'
import { EventTypes } from '~/types/events'
import { apiClient } from '~/utils/client'
import { eventBus } from '~/utils/event-emitter'

import styles from './LiveDeskStatus.module.css'

type RecordValue = Record<string, unknown>

type LiveDeskPlayback = {
  state: 'playing' | 'paused'
  durationMs: number | null
  positionMs: number | null
  anchorAt: string
  rate: number
}

type LiveDeskMedia = {
  title: string | null
  artist: string | null
  album: string | null
  playerName: string | null
  playback: LiveDeskPlayback
  link: string | null
}

type LiveDeskApplication = {
  displayName: string
  windowTitle: string | null
  icon: string | null
}

type LiveDeskState = {
  epoch: string
  revision: number
  projection: {
    availability: 'active' | 'idle'
    expiresAt: string
    application: LiveDeskApplication | null
    media: LiveDeskMedia | null
  } | null
}

const isRecord = (value: unknown): value is RecordValue =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const nullableString = (value: unknown) => {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized || null
}

const nullableNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const readNestedString = (value: unknown, key: string) =>
  isRecord(value) ? nullableString(value[key]) : null

const normalizeLiveDeskState = (value: unknown): LiveDeskState | null => {
  const result = isRecord(value) && !('schemaVersion' in value) ? value.state : value
  if (!isRecord(result)) {
    return null
  }

  const epoch = nullableString(result.epoch)
  if (
    result.schemaVersion !== 2 ||
    !epoch ||
    typeof result.revision !== 'number' ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 0
  ) {
    return null
  }

  if (result.projection === null) {
    return {
      epoch,
      revision: result.revision,
      projection: null,
    }
  }

  if (!isRecord(result.projection)) {
    return null
  }

  const { projection } = result
  const expiresAt = nullableString(projection.expiresAt)
  if (
    (projection.availability !== 'active' && projection.availability !== 'idle') ||
    !expiresAt ||
    Number.isNaN(Date.parse(expiresAt))
  ) {
    return null
  }

  const application = normalizeApplication(projection.application)
  const media = normalizeMedia(projection.media)
  if (projection.application !== null && !application) {
    return null
  }
  if (projection.media !== null && !media) {
    return null
  }

  return {
    epoch,
    revision: result.revision,
    projection: {
      availability: projection.availability,
      expiresAt,
      application,
      media,
    },
  }
}

const normalizeApplication = (value: unknown): LiveDeskApplication | null => {
  if (!isRecord(value)) {
    return null
  }

  const displayName = nullableString(value.displayName)
  if (!displayName) {
    return null
  }

  return {
    displayName,
    windowTitle: readNestedString(value.window, 'title'),
    icon: readNestedString(value.icon, 'url'),
  }
}

const normalizeMedia = (value: unknown): LiveDeskMedia | null => {
  if (!isRecord(value) || !isRecord(value.playback)) {
    return null
  }

  const { playback } = value
  const anchorAt = nullableString(playback.anchorAt)
  const rate = nullableNumber(playback.rate)
  if (
    (playback.state !== 'playing' && playback.state !== 'paused') ||
    !anchorAt ||
    Number.isNaN(Date.parse(anchorAt)) ||
    rate === null ||
    rate < 0
  ) {
    return null
  }

  return {
    title: nullableString(value.title),
    artist: nullableString(value.artist),
    album: nullableString(value.album),
    playerName: readNestedString(value.player, 'displayName'),
    playback: {
      state: playback.state,
      durationMs: nullableNumber(playback.durationMs),
      positionMs: nullableNumber(playback.positionMs),
      anchorAt,
      rate,
    },
    link: readNestedString(value.link, 'url'),
  }
}

const resolveNewerState = (
  current: LiveDeskState | null,
  incoming: LiveDeskState,
) => {
  if (!current || current.epoch !== incoming.epoch) {
    return incoming
  }

  return incoming.revision > current.revision ? incoming : current
}

const getSafePlaybackLink = (link: string | null) => {
  if (!link) {
    return null
  }

  try {
    const url = new URL(link)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

const formatDuration = (milliseconds: number | null) => {
  if (milliseconds === null || milliseconds < 0) {
    return null
  }

  const totalSeconds = Math.floor(milliseconds / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const clock = `${minutes.toString().padStart(2, '0')}:${seconds
    .toString()
    .padStart(2, '0')}`

  return hours ? `${hours}:${clock}` : clock
}

const getProjectedPosition = (media: LiveDeskMedia) => {
  const { playback } = media
  if (playback.positionMs === null || playback.state !== 'playing') {
    return playback.positionMs
  }

  const elapsed = Math.max(0, Date.now() - Date.parse(playback.anchorAt))
  const projected = playback.positionMs + elapsed * playback.rate
  return playback.durationMs === null
    ? projected
    : Math.min(projected, playback.durationMs)
}

const getVisibleProjection = (state: LiveDeskState | null) => {
  const projection = state?.projection
  if (
    !projection ||
    projection.availability !== 'active' ||
    Date.parse(projection.expiresAt) <= Date.now() ||
    (!projection.media && !projection.application)
  ) {
    return null
  }

  return projection
}

const isExpired = (state: LiveDeskState) => {
  const expiresAt = state.projection?.expiresAt
  return !!expiresAt && Date.parse(expiresAt) <= Date.now()
}

const getPresenceFromServer = async () => {
  const result = await apiClient.companion.getPublicPresence()
  return normalizeLiveDeskState(result)
}

const useLiveDeskState = () => {
  const [state, setState] = useState<LiveDeskState | null>(null)
  const stateRef = useRef<LiveDeskState | null>(null)
  const mountedRef = useRef(false)

  const applyState = useCallback((incoming: LiveDeskState) => {
    const next = resolveNewerState(stateRef.current, incoming)
    stateRef.current = next
    setState(isExpired(next) ? null : next)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const incoming = await getPresenceFromServer()
      if (incoming && mountedRef.current) {
        applyState(incoming)
      }
    } catch {
      // This is an optional, public decoration. Existing activity stays visible
      // until its server-issued expiry instead of surfacing a transient error.
    }
  }, [applyState])

  useEffect(() => {
    mountedRef.current = true
    void refresh()

    const handlePresenceChange = (payload: unknown) => {
      const incoming = normalizeLiveDeskState(payload)
      if (!incoming) {
        return
      }

      const previous = stateRef.current
      applyState(incoming)

      if (
        !previous ||
        previous.epoch !== incoming.epoch ||
        incoming.revision > previous.revision + 1
      ) {
        void refresh()
      }
    }
    const handleReconnect = () => {
      void refresh()
    }

    eventBus.on(EventTypes.COMPANION_PRESENCE_CHANGED, handlePresenceChange)
    socketClient.socket.on('connect', handleReconnect)

    return () => {
      mountedRef.current = false
      eventBus.off(EventTypes.COMPANION_PRESENCE_CHANGED, handlePresenceChange)
      socketClient.socket.off('connect', handleReconnect)
    }
  }, [applyState, refresh])

  const expiresAt = state?.projection?.expiresAt
  useEffect(() => {
    if (!expiresAt) {
      return
    }

    const timeout = window.setTimeout(
      () => {
        setState(null)
        void refresh()
      },
      Math.max(0, Date.parse(expiresAt) - Date.now()) + 50,
    )

    return () => {
      window.clearTimeout(timeout)
    }
  }, [expiresAt, refresh])

  return state
}

export const LiveDeskStatus: FC = () => {
  const config = useKamiConfig()

  if (!config.function.liveDesk?.enable) {
    return null
  }

  return <LiveDeskStatusContent />
}

const LiveDeskStatusContent: FC = () => {
  const t = useTranslations('liveDesk')
  const state = useLiveDeskState()
  const projection = getVisibleProjection(state)

  const presentation = useMemo(() => {
    if (!projection) {
      return null
    }

    const { application, media } = projection
    const title =
      media?.title ?? application?.windowTitle ?? application?.displayName ?? null
    if (!title) {
      return null
    }

    const byline = media?.artist ?? media?.album ?? media?.playerName ?? null
    const stateLabel = media
      ? media.playback.state === 'playing'
        ? t('playing')
        : t('paused')
      : t('active')
    const playerLabel = application?.displayName ?? media?.playerName ?? null
    const currentPosition = media ? formatDuration(getProjectedPosition(media)) : null
    const duration = media ? formatDuration(media.playback.durationMs) : null

    return {
      title,
      byline,
      stateLabel,
      playerLabel,
      icon: application?.icon ?? null,
      link: getSafePlaybackLink(media?.link ?? null),
      progress:
        currentPosition && duration ? t('progress', { currentPosition, duration }) : null,
    }
  }, [projection, t])

  if (!presentation) {
    return null
  }

  const openPlaybackLink = () => {
    if (!presentation.link) {
      return
    }

    const opened = window.open(presentation.link, '_blank', 'noopener,noreferrer')
    if (opened) {
      opened.opener = null
    }
  }

  const card = () => (
    <button
      type="button"
      className={clsx(styles.card, presentation.link && styles.clickable)}
      onClick={openPlaybackLink}
      aria-label={
        presentation.link ? t('open', { title: presentation.title }) : presentation.title
      }
    >
      <span className={styles.icon}>
        {presentation.icon ? (
          <img src={presentation.icon} alt="" referrerPolicy="no-referrer" />
        ) : (
          <MusicIcon aria-hidden="true" />
        )}
      </span>
      <span className={styles.copy}>
        <span className={styles.meta}>
          <span className={styles.meter} aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span>{presentation.stateLabel}</span>
          {presentation.byline && <span> · {presentation.byline}</span>}
        </span>
        <span className={styles.title}>{presentation.title}</span>
      </span>
    </button>
  )

  return (
    <div className={styles.root}>
      <FloatPopover
        headless
        placement="bottom"
        offset={12}
        wrapperClassNames={styles.trigger}
        triggerComponent={card}
      >
        <div className={styles.popover}>
          <p className={styles.popoverTitle}>{presentation.title}</p>
          {presentation.byline && (
            <p className={styles.popoverMeta}>{presentation.byline}</p>
          )}
          {presentation.playerLabel && (
            <p className={styles.popoverMeta}>
              {t('via', { player: presentation.playerLabel })}
            </p>
          )}
          {presentation.progress && (
            <p className={styles.popoverMeta}>{presentation.progress}</p>
          )}
        </div>
      </FloatPopover>
    </div>
  )
}

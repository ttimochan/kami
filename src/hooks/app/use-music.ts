import { useEffect } from 'react'
import { useMusicStore } from '~/atoms/music'

export const useMusic = (musicList: number[] | null) => {
  useEffect(() => {
    if (!musicList) {
      return
    }
    const musicStore = useMusicStore.getState()
    if (musicList.length === 0) {
      musicStore.empty()
      return
    }
    musicStore.setPlaylist(musicList)
    musicStore.setHide(false)

    return () => {
      musicStore.empty()
      musicStore.setHide(true)
    }
  }, [musicList])
}

export const useNoteMusic = (music?: string) => {
  useMusic(music ? [parseInt(music)] : null)
}

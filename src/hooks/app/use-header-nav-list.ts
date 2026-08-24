import { useMemo } from 'react'

import { uniqBy } from '~/utils/_'

import { useInitialData, useKamiConfig, usePageMeta } from './use-initial-data'

export const useHeaderNavList = () => {
  const {
    site: {
      header: { menu },
    },
  } = useKamiConfig()
  const { categories } = useInitialData()
  const pageMeta = usePageMeta()
  const mergedMenu = useMemo(() => {
    const merged = menu.map((item) =>
      item.type === 'Note' && item.path === '/notes'
        ? { ...item, path: '/notes/latest' }
        : item,
    )
    const homeMenuIndex = merged.findIndex((m) => m.type === 'Home')
    // 1. merge pages
    const homeMenu = merged[homeMenuIndex]
    if (!homeMenu) {
      return merged
    }
    const models = pageMeta.map((page) => {
      const { title, id, slug } = page
      return {
        title,
        id,
        path: `/${slug}`,
        type: 'Page',
      }
    })

    merged[homeMenuIndex] = {
      ...homeMenu,
      subMenu: uniqBy(
        [...(homeMenu.subMenu ?? []), ...models],
        'id' as any,
      ) as any,
    }

    // 2. merge categories
    {
      const postMenu = merged.find((menu) => menu.type === 'Post')
      if (!postMenu || !postMenu.subMenu) {
        return merged
      }
      const models = (categories ?? []).map((category) => {
        const { id, slug, name } = category
        return {
          title: name,
          id,

          path: `/categories/${slug}`,
          type: 'Custom',
        }
      })
      const postMenuIndex = merged.indexOf(postMenu)
      merged[postMenuIndex] = {
        ...postMenu,
        subMenu: uniqBy(
          [...models, ...(postMenu.subMenu ?? [])],
          'id' as any,
        ) as any,
      }
    }
    return merged
  }, [categories, menu, pageMeta])

  return { mergedMenu }
}

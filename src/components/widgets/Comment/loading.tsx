/*
 * @Author: timochan
 * @Date: 2024-07-10 19:23:55
 * @LastEditors: timochan
 * @LastEditTime: 2024-07-10 19:25:52
 * @FilePath: /kami/src/components/widgets/Comment/loading.tsx
 */
import React, { memo } from 'react'

import { Loading } from '~/components/ui/Loading'

export const CommentLoading = memo(() => {
  return (
    <>
      <div className="pt-[150px]" />
      <Loading loadingText="Loading Comments..." />
    </>
  )
})

import { useEffect } from "react"
import { apiClient } from "~/utils/client"

export const useAckReadCount = (
  type: 'post' | 'note',
  id: string
) => {
  useEffect(() => {
    apiClient.ack.read(type, id)
  }, [id])
}
'use client'

import { useState, useEffect } from 'react'

export function useVibration(): {
  vibrate: (pattern: number | number[]) => void
  isSupported: boolean
} {
  const [isSupported, setIsSupported] = useState<boolean>(false)

  useEffect(() => {
    const checkSupport = (): void => {
      if (typeof window !== 'undefined' && 'navigator' in window) {
        setIsSupported('vibrate' in navigator)
      }
    }
    checkSupport()
  }, [])

  const vibrate = (pattern: number | number[]): void => {
    if (isSupported && navigator.vibrate) {
      navigator.vibrate(pattern)
    }
  }

  return {
    vibrate,
    isSupported
  }
}

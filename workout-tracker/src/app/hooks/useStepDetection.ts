'use client'

import { useState, useEffect, useRef } from 'react'

interface AccelerometerData {
  x: number
  y: number
  z: number
}

export function useStepDetection(isActive: boolean): {
  steps: number
  isSupported: boolean
  requestPermission: () => Promise<void>
} {
  const [steps, setSteps] = useState<number>(0)
  const [isSupported, setIsSupported] = useState<boolean>(false)
  const [hasPermission, setHasPermission] = useState<boolean>(false)

  const lastAcceleration = useRef<AccelerometerData>({ x: 0, y: 0, z: 0 })
  const stepThreshold = useRef<number>(2.5)
  const lastStepTime = useRef<number>(0)
  const minStepInterval = useRef<number>(300) // Minimum 300ms between steps

  // Check for device motion support
  useEffect(() => {
    const checkSupport = (): void => {
      if (typeof window !== 'undefined') {
        setIsSupported('DeviceMotionEvent' in window)
      }
    }
    checkSupport()
  }, [])

  // Request permission for device motion
  const requestPermission = async (): Promise<void> => {
    if (!isSupported) return

    try {
      // For iOS 13+ devices
      if (typeof (DeviceMotionEvent as any).requestPermission === 'function') {
        const permission = await (DeviceMotionEvent as any).requestPermission()
        setHasPermission(permission === 'granted')
      } else {
        // For other devices, assume permission is granted
        setHasPermission(true)
      }
    } catch (error) {
      console.error('Error requesting device motion permission:', error)
      setHasPermission(false)
    }
  }

  // Step detection logic
  useEffect(() => {
    if (!isActive || !isSupported || !hasPermission) return

    const handleDeviceMotion = (event: DeviceMotionEvent): void => {
      const acceleration = event.accelerationIncludingGravity
      if (!acceleration || acceleration.x === null || acceleration.y === null || acceleration.z === null) return

      const currentAcceleration: AccelerometerData = {
        x: acceleration.x,
        y: acceleration.y,
        z: acceleration.z
      }

      // Calculate the magnitude of acceleration change
      const deltaX = currentAcceleration.x - lastAcceleration.current.x
      const deltaY = currentAcceleration.y - lastAcceleration.current.y
      const deltaZ = currentAcceleration.z - lastAcceleration.current.z

      const magnitude = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ)

      // Detect step if magnitude exceeds threshold and enough time has passed
      const currentTime = Date.now()
      if (magnitude > stepThreshold.current && currentTime - lastStepTime.current > minStepInterval.current) {
        setSteps(prev => prev + 1)
        lastStepTime.current = currentTime
      }

      lastAcceleration.current = currentAcceleration
    }

    window.addEventListener('devicemotion', handleDeviceMotion)

    return () => {
      window.removeEventListener('devicemotion', handleDeviceMotion)
    }
  }, [isActive, isSupported, hasPermission])

  // Reset steps when workout stops
  useEffect(() => {
    if (!isActive) {
      // Don't reset steps here - let the parent component handle it
    }
  }, [isActive])

  return {
    steps,
    isSupported,
    requestPermission
  }
}
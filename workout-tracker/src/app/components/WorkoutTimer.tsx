'use client'

import React, { JSX, useEffect, useState } from 'react'
import { useVibration } from '../hooks/useVibration'

interface WorkoutTimerProps {
  duration: number
  startTime: number | null
  isActive: boolean
  onStop: () => void
  onProgressUpdate: (phaseTimeRemaining: number, totalTimeRemaining: number, currentPhase: 'slow' | 'brisk') => void
}

export function WorkoutTimer({ duration, startTime, isActive, onStop, onProgressUpdate }: WorkoutTimerProps): JSX.Element {
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0)
  const { vibrate, isSupported: vibrateSupported } = useVibration()

  useEffect(() => {
    if (!isActive || !startTime) return

    const interval = setInterval(() => {
      const now = Date.now()
      const elapsed = Math.floor((now - startTime) / 1000)
      setElapsedSeconds(elapsed)

      const totalDurationSeconds = duration * 60
      const totalTimeRemaining = Math.max(0, totalDurationSeconds - elapsed)

      // Calculate current phase (3-minute intervals)
      const phaseNumber = Math.floor(elapsed / 180) // 180 seconds = 3 minutes
      const currentPhase: 'slow' | 'brisk' = phaseNumber % 2 === 0 ? 'slow' : 'brisk'
      const phaseElapsed = elapsed % 180
      const phaseTimeRemaining = Math.max(0, 180 - phaseElapsed)

      // Vibrate at phase transitions (when phaseElapsed is 0 and not at start)
      if (phaseElapsed === 0 && elapsed > 0 && vibrateSupported) {
        vibrate([200, 100, 200]) // Double vibration pattern
      }

      // Update parent component
      onProgressUpdate(phaseTimeRemaining, totalTimeRemaining, currentPhase)

      // Stop workout when time is up
      if (totalTimeRemaining <= 0) {
        onStop()
        if (vibrateSupported) {
          vibrate([500, 200, 500, 200, 500]) // Completion vibration
        }
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [isActive, startTime, duration, onProgressUpdate, onStop, vibrate, vibrateSupported])

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const getProgressPercentage = (): number => {
    const totalDurationSeconds = duration * 60
    return (elapsedSeconds / totalDurationSeconds) * 100
  }

  return (
    <div className="bg-white rounded-xl shadow-md p-6">
      <div className="text-center mb-6">
        <h3 className="text-lg font-semibold text-gray-800 mb-2">Workout in Progress</h3>
        <div className="text-3xl font-bold text-blue-600 mb-2">
          {formatTime(elapsedSeconds)}
        </div>
        <div className="text-sm text-gray-600">
          of {duration} minutes
        </div>
      </div>

      {/* Progress Bar */}
      <div className="mb-6">
        <div className="flex justify-between text-sm text-gray-600 mb-2">
          <span>Progress</span>
          <span>{Math.round(getProgressPercentage())}%</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-3">
          <div
            className="bg-gradient-to-r from-blue-500 to-green-500 h-3 rounded-full transition-all duration-1000"
            style={{ width: `${Math.min(100, getProgressPercentage())}%` }}
          />
        </div>
      </div>

      {/* Control Buttons */}
      <div className="space-y-3">
        <button
          onClick={onStop}
          className="w-full py-3 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors font-semibold"
        >
          🛑 Stop Workout
        </button>

        {!vibrateSupported && (
          <div className="text-center text-sm text-gray-500">
            📳 Vibration not supported on this device
          </div>
        )}
      </div>
    </div>
  )
}
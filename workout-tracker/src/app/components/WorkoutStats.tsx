'use client'

import React, { JSX } from 'react'

interface WorkoutStatsProps {
  steps: number
  currentPhase: 'slow' | 'brisk'
  phaseTimeRemaining: number
  totalTimeRemaining: number
}

export function WorkoutStats({ steps, currentPhase, phaseTimeRemaining, totalTimeRemaining }: WorkoutStatsProps): JSX.Element {
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const getPhaseInfo = (): { icon: string; text: string; color: string } => {
    if (currentPhase === 'slow') {
      return {
        icon: '🚶‍♂️',
        text: 'Slow Walking',
        color: 'text-blue-600 bg-blue-50'
      }
    } else {
      return {
        icon: '🏃‍♂️',
        text: 'Brisk Walking',
        color: 'text-green-600 bg-green-50'
      }
    }
  }

  const phaseInfo = getPhaseInfo()

  return (
    <div className="grid grid-cols-2 gap-4">
      {/* Current Phase */}
      <div className="bg-white rounded-xl shadow-md p-4">
        <div className="text-center">
          <div className="text-2xl mb-1">{phaseInfo.icon}</div>
          <div className={`px-3 py-1 rounded-full text-sm font-medium ${phaseInfo.color}`}>
            {phaseInfo.text}
          </div>
          <div className="mt-2 text-lg font-bold text-gray-800">
            {formatTime(phaseTimeRemaining)}
          </div>
          <div className="text-xs text-gray-500">remaining</div>
        </div>
      </div>

      {/* Total Time */}
      <div className="bg-white rounded-xl shadow-md p-4">
        <div className="text-center">
          <div className="text-2xl mb-1">⏱️</div>
          <div className="text-sm font-medium text-gray-600 mb-1">
            Total Time
          </div>
          <div className="text-lg font-bold text-gray-800">
            {formatTime(totalTimeRemaining)}
          </div>
          <div className="text-xs text-gray-500">remaining</div>
        </div>
      </div>

      {/* Steps Progress */}
      <div className="col-span-2 bg-white rounded-xl shadow-md p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="text-2xl">👟</div>
            <div>
              <div className="text-lg font-bold text-gray-800">{steps}</div>
              <div className="text-sm text-gray-600">Steps</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-gray-600">Estimated</div>
            <div className="text-lg font-bold text-blue-600">
              {Math.round(steps * 0.0005 * 100) / 100} km
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
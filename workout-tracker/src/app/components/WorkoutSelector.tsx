'use client'

import React, { JSX } from 'react'

interface WorkoutSelectorProps {
  onSelectDuration: (duration: number) => void
}

export function WorkoutSelector({ onSelectDuration }: WorkoutSelectorProps): JSX.Element {
  const durations: Array<{ value: number; label: string; emoji: string }> = [
    { value: 15, label: '15 Minutes', emoji: '🚶‍♂️' },
    { value: 30, label: '30 Minutes', emoji: '🏃‍♂️' },
    { value: 45, label: '45 Minutes', emoji: '🏃‍♀️' },
    { value: 60, label: '60 Minutes', emoji: '💪' }
  ]

  return (
    <div className="bg-white rounded-2xl shadow-lg p-6">
      <h2 className="text-2xl font-bold text-gray-800 text-center mb-6">
        Choose Your Workout Duration
      </h2>
      
      <div className="grid grid-cols-1 gap-4">
        {durations.map(({ value, label, emoji }) => (
          <button
            key={value}
            onClick={() => onSelectDuration(value)}
            className="flex items-center justify-between p-4 bg-gradient-to-r from-blue-500 to-green-500 text-white rounded-xl hover:from-blue-600 hover:to-green-600 transform hover:scale-105 transition-all duration-200 shadow-md"
          >
            <span className="text-3xl">{emoji}</span>
            <span className="text-xl font-semibold">{label}</span>
            <span className="text-sm opacity-80">{value}m</span>
          </button>
        ))}
      </div>

      <div className="mt-6 p-4 bg-blue-50 rounded-lg">
        <h3 className="font-semibold text-gray-800 mb-2">📋 Workout Plan:</h3>
        <ul className="text-sm text-gray-600 space-y-1">
          <li>• First 3 minutes: Slow walking pace</li>
          <li>• Next 3 minutes: Brisk walking pace</li>
          <li>• Alternates every 3 minutes</li>
          <li>• Vibration alerts for pace changes</li>
        </ul>
      </div>
    </div>
  )
}
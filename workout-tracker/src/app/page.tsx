'use client'

import React, { useState, useEffect, JSX } from 'react'
import { WorkoutTimer } from './components/WorkoutTimer'
import { StepCounter } from './components/StepCounter'
import { WorkoutSelector } from './components/WorkoutSelector'
import { WorkoutStats } from './components/WorkoutStats'

interface WorkoutData {
  duration: number
  startTime: number | null
  isActive: boolean
  currentPhase: 'slow' | 'brisk'
  phaseTimeRemaining: number
  totalTimeRemaining: number
}

export default function WorkoutTrackerPage(): JSX.Element {
  const [workout, setWorkout] = useState<WorkoutData>({
    duration: 0,
    startTime: null,
    isActive: false,
    currentPhase: 'slow',
    phaseTimeRemaining: 180, // 3 minutes in seconds
    totalTimeRemaining: 0
  })

  const [steps, setSteps] = useState<number>(0)
  const [showSelector, setShowSelector] = useState<boolean>(true)

  const startWorkout = (duration: number): void => {
    const now = Date.now()
    setWorkout({
      duration,
      startTime: now,
      isActive: true,
      currentPhase: 'slow',
      phaseTimeRemaining: 180,
      totalTimeRemaining: duration * 60
    })
    setShowSelector(false)
    setSteps(0)
  }

  const stopWorkout = (): void => {
    setWorkout({
      duration: 0,
      startTime: null,
      isActive: false,
      currentPhase: 'slow',
      phaseTimeRemaining: 180,
      totalTimeRemaining: 0
    })
    setShowSelector(true)
  }

  const updateWorkoutProgress = (phaseTimeRemaining: number, totalTimeRemaining: number, currentPhase: 'slow' | 'brisk'): void => {
    setWorkout(prev => ({
      ...prev,
      phaseTimeRemaining,
      totalTimeRemaining,
      currentPhase
    }))
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-green-50 p-4">
      <div className="max-w-md mx-auto">
        <header className="text-center mb-8 pt-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">🏃‍♂️ Workout Tracker</h1>
          <p className="text-gray-600">Track your steps and stay on pace!</p>
        </header>

        {showSelector ? (
          <WorkoutSelector onSelectDuration={startWorkout} />
        ) : (
          <div className="space-y-6">
            <WorkoutStats 
              steps={steps}
              currentPhase={workout.currentPhase}
              phaseTimeRemaining={workout.phaseTimeRemaining}
              totalTimeRemaining={workout.totalTimeRemaining}
            />
            
            <StepCounter 
              isActive={workout.isActive}
              onStepUpdate={setSteps}
            />
            
            <WorkoutTimer
              duration={workout.duration}
              startTime={workout.startTime}
              isActive={workout.isActive}
              onStop={stopWorkout}
              onProgressUpdate={updateWorkoutProgress}
            />
          </div>
        )}
      </div>
    </main>
  )
}
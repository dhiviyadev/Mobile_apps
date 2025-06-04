'use client'

import React, { JSX, useEffect, useState } from 'react'
import { useStepDetection } from '../hooks/useStepDetection'

interface StepCounterProps {
  isActive: boolean
  onStepUpdate: (steps: number) => void
}

export function StepCounter({ isActive, onStepUpdate }: StepCounterProps): JSX.Element {
  const { steps, isSupported, requestPermission } = useStepDetection(isActive)
  const [hasRequestedPermission, setHasRequestedPermission] = useState<boolean>(false)

  useEffect(() => {
    onStepUpdate(steps)
  }, [steps, onStepUpdate])

  const handleRequestPermission = async (): Promise<void> => {
    setHasRequestedPermission(true)
    await requestPermission()
  }

  return (
    <div className="bg-white rounded-xl shadow-md p-6">
      <div className="text-center">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">👟 Step Counter</h3>
        
        {!isSupported ? (
          <div className="text-gray-500">
            <p>Step detection not supported on this device</p>
            <p className="text-sm mt-1">Manual counting: Tap to add steps</p>
            <button
              onClick={() => onStepUpdate(steps + 1)}
              className="mt-3 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
            >
              Add Step (+1)
            </button>
          </div>
        ) : !hasRequestedPermission ? (
          <div className="text-center">
            <p className="text-gray-600 mb-4">Enable motion detection for automatic step counting</p>
            <button
              onClick={handleRequestPermission}
              className="px-6 py-3 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors font-semibold"
            >
              Enable Step Detection
            </button>
          </div>
        ) : (
          <div>
            <div className="text-5xl font-bold text-blue-600 mb-2">{steps}</div>
            <p className="text-gray-600">Steps taken</p>
            {isActive && (
              <div className="mt-2 text-sm text-green-600 font-medium">
                📱 Detecting steps...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
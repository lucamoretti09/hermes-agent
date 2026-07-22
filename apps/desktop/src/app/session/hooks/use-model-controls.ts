import { type QueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'

import type { ModelSelection } from '@/app/shell/model-menu-panel'
import { getGlobalModelInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { manualPickRemoved } from '@/lib/model-options'
import { notifyError } from '@/store/notifications'
import {
  $activeSessionId,
  $currentModel,
  $currentProvider,
  getComposerSelectionGeneration,
  getCurrentModelSource,
  markComposerSelectionManual,
  setCurrentModel,
  setCurrentModelSource,
  setCurrentProvider
} from '@/store/session'
import { $sessionStates, sessionTileDelegate } from '@/store/session-states'
import type { ModelOptionsResponse } from '@/types/hermes'

interface ModelControlsOptions {
  queryClient: QueryClient
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
}

interface ModelSwitchResponse {
  confirm_message?: string
  confirm_required?: boolean
  error?: string
  ok?: boolean
  warning?: string
}

export interface PendingModelConfirmation {
  message: string
  selection: ModelSelection
}

export function useModelControls({ queryClient, requestGateway }: ModelControlsOptions) {
  const { t } = useI18n()
  const copy = t.desktop
  const modelSwitchEpochsRef = useRef(new Map<string, number>())
  const modelSwitchQueuesRef = useRef(new Map<string, Promise<void>>())
  const profileRefreshEpochRef = useRef(0)
  const [pendingModelConfirmation, setPendingModelConfirmation] = useState<PendingModelConfirmation | null>(null)

  // All callbacks here read reactive session state from the store (.get())
  // rather than capturing it as a prop. The actions bag in wiring.tsx mutates
  // in place to keep a stable identity, so memoized surfaces capture these
  // callbacks once and never re-evaluate — a captured prop would be stale
  // forever. The store read is always current.
  const updateModelOptionsCache = useCallback(
    (sessionId: null | string, provider: string, model: string, includeGlobal: boolean) => {
      const patch = (prev: ModelOptionsResponse | undefined) => ({ ...(prev ?? {}), provider, model })

      queryClient.setQueryData<ModelOptionsResponse>(['model-options', sessionId || 'global'], patch)

      if (includeGlobal) {
        queryClient.setQueryData<ModelOptionsResponse>(['model-options', 'global'], patch)
      }
    },
    [queryClient]
  )

  // Seed the composer's model state from the profile default. `force` reseeds
  // for a profile swap (the new profile has its own default); otherwise this
  // only fills an EMPTY selection so a user's pick (plain UI state in
  // $currentModel) survives the lifecycle refreshes that fire on boot / fresh
  // draft / session events. A live session owns the footer, so skip entirely.
  const refreshCurrentModel = useCallback(
    async (force = false) => {
      // A forced profile swap opens a new intent epoch; an older in-flight
      // response for a previous profile must stand down when it resolves.
      if (force) {
        profileRefreshEpochRef.current += 1
      }

      const profileRefreshEpoch = profileRefreshEpochRef.current

      try {
        if ($activeSessionId.get()) {
          return
        }

        // A manual pick stays sticky UNLESS it was removed from the catalog (its
        // model no longer exists on the provider), in which case keeping it would
        // 404 every new chat — fall through to reseed from the profile default.
        // Reads the model-options cache the composer already populated; an
        // unknown/not-yet-loaded catalog conservatively preserves the pick.
        const keepManualPick = () => {
          if (force || !$currentModel.get() || getCurrentModelSource() !== 'manual') {
            return false
          }

          const options = queryClient.getQueryData<ModelOptionsResponse>(['model-options', 'global'])

          return !manualPickRemoved(options?.providers, $currentProvider.get(), $currentModel.get())
        }

        if (keepManualPick()) {
          return
        }

        // Snapshot the selection generation before awaiting so a picker click
        // that lands while getGlobalModelInfo is in flight wins over this older
        // default — value comparisons alone miss re-selecting the same row.
        const selectionGeneration = getComposerSelectionGeneration()
        const result = await getGlobalModelInfo()

        if (
          profileRefreshEpochRef.current !== profileRefreshEpoch ||
          $activeSessionId.get() ||
          getComposerSelectionGeneration() !== selectionGeneration ||
          keepManualPick()
        ) {
          return
        }

        if (typeof result.model === 'string') {
          setCurrentModel(result.model)
        }

        if (typeof result.provider === 'string') {
          setCurrentProvider(result.provider)
        }

        if (typeof result.model === 'string' || typeof result.provider === 'string') {
          setCurrentModelSource('default')
        }
      } catch {
        // The delayed session.info event still updates this once the agent is ready.
      }
    },
    [queryClient]
  )

  // Returns whether the switch succeeded so callers can await it before applying
  // follow-up changes. The composer model is plain UI state: with no live
  // session it's just stored (and shipped on the next session.create); with one
  // it's scoped to that session via config.set. It NEVER writes the profile
  // default — that lives in Settings → Model — so picking a model here can't
  // silently mutate global config.
  //
  // `selection.sessionId` targets a specific surface (tile). When omitted, the
  // primary `$activeSessionId` is used (overlay / legacy callers). A tile
  // switch must not touch the primary globals — and must not be blocked by a
  // busy primary turn.
  const selectModel = useCallback(
    async (selection: ModelSelection): Promise<boolean> => {
      const primaryRuntimeId = $activeSessionId.get()
      const liveSessionId = 'sessionId' in selection ? (selection.sessionId ?? null) : primaryRuntimeId
      const touchesPrimary = !liveSessionId || liveSessionId === primaryRuntimeId

      const prevModel = touchesPrimary ? $currentModel.get() : ($sessionStates.get()[liveSessionId!]?.model ?? '')

      const prevProvider = touchesPrimary
        ? $currentProvider.get()
        : ($sessionStates.get()[liveSessionId!]?.provider ?? '')

      const prevSource = getCurrentModelSource()

      if (touchesPrimary) {
        setCurrentModel(selection.model)
        setCurrentProvider(selection.provider)
        markComposerSelectionManual()
      } else if (liveSessionId) {
        // Optimistic tile paint — session.info will confirm; rollback on error.
        sessionTileDelegate()?.updateSession(liveSessionId, state => ({
          ...state,
          model: selection.model,
          provider: selection.provider
        }))
      }

      updateModelOptionsCache(liveSessionId, selection.provider, selection.model, touchesPrimary && !liveSessionId)

      const rollback = () => {
        if (touchesPrimary) {
          setCurrentModel(prevModel)
          setCurrentProvider(prevProvider)
          setCurrentModelSource(prevSource)
        } else if (liveSessionId) {
          sessionTileDelegate()?.updateSession(liveSessionId, state => ({
            ...state,
            model: prevModel,
            provider: prevProvider
          }))
        }

        updateModelOptionsCache(liveSessionId, prevProvider, prevModel, touchesPrimary && !liveSessionId)
      }

      // No live session yet: the pick is pure UI state. session.create reads
      // $currentModel/$currentProvider and applies it as that session's override.
      if (!liveSessionId) {
        return true
      }

      const switchEpoch = (modelSwitchEpochsRef.current.get(liveSessionId) ?? 0) + 1
      modelSwitchEpochsRef.current.set(liveSessionId, switchEpoch)
      const isLatestSwitch = () => modelSwitchEpochsRef.current.get(liveSessionId) === switchEpoch

      const performSwitch = async (): Promise<boolean> => {
        try {
          const result = await requestGateway<ModelSwitchResponse>('config.set', {
            ...(selection.confirmExpensiveModel && { confirm_expensive_model: true }),
            session_id: liveSessionId,
            key: 'model',
            value: `${selection.model} --provider ${selection.provider} --session`
          })

          // A newer click owns both the optimistic UI and any confirmation.
          // Requests are serialized below so the newer backend write still
          // runs after this stale response, preserving last-selection-wins.
          if (!isLatestSwitch()) {
            return false
          }

          if (result?.confirm_required) {
            rollback()
            setPendingModelConfirmation({
              message: result.confirm_message || result.warning || 'This model has unusually high known pricing.',
              selection: { ...selection, confirmExpensiveModel: true }
            })

            return false
          }

          if (result?.ok === false) {
            rollback()
            notifyError(new Error(result.error || result.warning || copy.modelSwitchFailed), copy.modelSwitchFailed)

            return false
          }

          void queryClient.invalidateQueries({ queryKey: ['model-options', liveSessionId] })

          return true
        } catch (err) {
          if (isLatestSwitch()) {
            rollback()
            notifyError(err, copy.modelSwitchFailed)
          }

          return false
        }
      }

      const precedingSwitch = modelSwitchQueuesRef.current.get(liveSessionId) ?? Promise.resolve()
      const switchPromise = precedingSwitch.catch(() => undefined).then(performSwitch)

      const queueTail = switchPromise.then(
        () => undefined,
        () => undefined
      )

      modelSwitchQueuesRef.current.set(liveSessionId, queueTail)

      try {
        return await switchPromise
      } finally {
        if (modelSwitchQueuesRef.current.get(liveSessionId) === queueTail) {
          modelSwitchQueuesRef.current.delete(liveSessionId)
          modelSwitchEpochsRef.current.delete(liveSessionId)
        }
      }
    },
    [copy.modelSwitchFailed, queryClient, requestGateway, updateModelOptionsCache]
  )

  const cancelModelConfirmation = useCallback(() => setPendingModelConfirmation(null), [])

  const confirmPendingModelSelection = useCallback(async () => {
    if (!pendingModelConfirmation) {
      return
    }

    const accepted = await selectModel(pendingModelConfirmation.selection)

    if (!accepted) {
      throw new Error(copy.modelSwitchFailed)
    }
  }, [copy.modelSwitchFailed, pendingModelConfirmation, selectModel])

  return {
    cancelModelConfirmation,
    confirmPendingModelSelection,
    pendingModelConfirmation,
    refreshCurrentModel,
    selectModel,
    updateModelOptionsCache
  }
}

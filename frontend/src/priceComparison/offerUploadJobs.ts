import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PriceComparisonError } from "./client";
import {
  cancelOfferUploadJob,
  confirmOfferUploadJob,
  createOfferUploadJob,
  listOfferUploadJobs,
  type OfferUploadJob,
  type OfferUploadJobStatus,
} from "./uploads";

export type LocalOfferUploadSubmission = {
  clientRequestId: string;
  files: File[];
  fileNames: string[];
  status: "submitting" | "uncertain" | "failed";
  error: string | null;
};

type OfferUploadJobsState = {
  sessionKey: number | string | null;
  jobs: OfferUploadJob[];
  submissions: LocalOfferUploadSubmission[];
  loading: boolean;
  stale: boolean;
  error: string | null;
  actionIds: string[];
};

export type OfferUploadJobs = Omit<OfferUploadJobsState, "sessionKey" | "actionIds"> & {
  enqueue: (files: readonly File[]) => void;
  retrySubmission: (clientRequestId: string) => void;
  dismissSubmission: (clientRequestId: string) => void;
  confirm: (job: OfferUploadJob) => void;
  cancel: (job: OfferUploadJob) => void;
  refresh: () => void;
  isActing: (jobId: string) => boolean;
};

const ACTIVE_POLL_MS = 1_000;
const IDLE_POLL_MS = 10_000;
const JOB_STATUSES = new Set<OfferUploadJobStatus>([
  "queued",
  "processing",
  "awaiting_confirmation",
  "completed",
  "failed",
  "cancelled",
]);

export function offerUploadPollDelay(
  jobs: readonly Pick<OfferUploadJob, "status">[],
  submissions: readonly Pick<LocalOfferUploadSubmission, "status">[] = [],
): number {
  return jobs.some((job) => job.status === "queued" || job.status === "processing")
    || submissions.some((submission) => submission.status === "submitting" || submission.status === "uncertain")
    ? ACTIVE_POLL_MS
    : IDLE_POLL_MS;
}

export function useOfferUploadJobs(
  sessionKey: number | string | null,
  onCompleted: (job: OfferUploadJob) => void,
): OfferUploadJobs {
  const [state, setState] = useState<OfferUploadJobsState>(() => initialState(sessionKey));
  const stateRef = useRef(state);
  const generation = useRef(0);
  const wakePoll = useRef<() => void>(() => undefined);
  const completionHandler = useRef(onCompleted);
  const completedKeys = useRef(new Set<string>());
  const pollInitialized = useRef(false);

  useEffect(() => { completionHandler.current = onCompleted; }, [onCompleted]);

  const updateState = useCallback((updater: (current: OfferUploadJobsState) => OfferUploadJobsState) => {
    const next = updater(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  const publishCompletion = useCallback((job: OfferUploadJob) => {
    if (job.status !== "completed" || !job.result_revision) return;
    const key = `${job.id}:${job.result_revision}`;
    if (completedKeys.current.has(key)) return;
    completedKeys.current.add(key);
    completionHandler.current(job);
  }, []);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    updateState(() => initialState(sessionKey));
    completedKeys.current.clear();
    pollInitialized.current = false;
    let stopped = false;
    let timer: number | null = null;
    let requestController: AbortController | null = null;
    let requestId = 0;

    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const schedule = (delay: number) => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => { void poll(false); }, delay);
    };
    const poll = async (force: boolean) => {
      if (stopped || document.visibilityState !== "visible") return;
      if (requestController) {
        if (!force) return;
        requestId += 1;
        requestController.abort();
      }
      clearTimer();
      const controller = new AbortController();
      requestController = controller;
      const currentRequest = ++requestId;
      let nextJobs: OfferUploadJob[] | null = null;
      try {
        const response = await listOfferUploadJobs(controller.signal);
        if (stopped || currentGeneration !== generation.current || currentRequest !== requestId) return;
        nextJobs = parseJobs(response.jobs);
        const previousJobs = new Map(stateRef.current.jobs.map((job) => [job.id, job]));
        const pendingClientRequestIds = new Set(
          stateRef.current.submissions.map((submission) => submission.clientRequestId),
        );
        const clientRequestIds = new Set(nextJobs.map((job) => job.client_request_id));
        updateState((current) => current.sessionKey !== sessionKey ? current : ({
          ...current,
          jobs: nextJobs!,
          submissions: current.submissions.filter((submission) => !clientRequestIds.has(submission.clientRequestId)),
          loading: false,
          stale: false,
          error: null,
        }));
        if (!pollInitialized.current) {
          nextJobs.forEach((job) => {
            if (job.status === "completed" && job.result_revision) {
              const previous = previousJobs.get(job.id);
              if (pendingClientRequestIds.has(job.client_request_id) || (previous && previous.status !== "completed")) {
                publishCompletion(job);
              } else {
                completedKeys.current.add(`${job.id}:${job.result_revision}`);
              }
            }
          });
          pollInitialized.current = true;
        } else {
          nextJobs.forEach(publishCompletion);
        }
      } catch (error) {
        if (stopped || currentGeneration !== generation.current || currentRequest !== requestId || isAbortError(error)) return;
        updateState((current) => current.sessionKey !== sessionKey ? current : ({
          ...current,
          loading: false,
          stale: Boolean(current.jobs.length),
          error: errorMessage(error, "Der Status der Upload-Warteschlange konnte nicht geladen werden."),
        }));
      } finally {
        if (requestController === controller) requestController = null;
        if (!stopped && currentGeneration === generation.current && currentRequest === requestId) {
          const current = stateRef.current;
          schedule(offerUploadPollDelay(nextJobs ?? current.jobs, current.submissions));
        }
      }
    };

    const refresh = () => {
      clearTimer();
      void poll(true);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
      else {
        clearTimer();
        requestId += 1;
        requestController?.abort();
        requestController = null;
      }
    };

    wakePoll.current = refresh;
    document.addEventListener("visibilitychange", onVisibilityChange);
    refresh();
    return () => {
      stopped = true;
      if (generation.current === currentGeneration) generation.current += 1;
      clearTimer();
      requestId += 1;
      requestController?.abort();
      requestController = null;
      wakePoll.current = () => undefined;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [publishCompletion, sessionKey, updateState]);

  const submit = useCallback(async (
    files: File[],
    clientRequestId: string,
  ) => {
    const actionGeneration = generation.current;
    updateState((current) => current.sessionKey !== sessionKey ? current : ({
      ...current,
      submissions: upsertSubmission(current.submissions, {
        clientRequestId,
        files,
        fileNames: files.map((file) => file.name),
        status: "submitting",
        error: null,
      }),
    }));
    try {
      const response = await createOfferUploadJob(files, clientRequestId);
      if (actionGeneration !== generation.current || stateRef.current.sessionKey !== sessionKey) return;
      const job = parseJob(response.job);
      updateState((current) => ({
        ...current,
        jobs: upsertJob(current.jobs, job),
        submissions: current.submissions.filter((submission) => submission.clientRequestId !== clientRequestId),
        error: null,
      }));
      publishCompletion(job);
      wakePoll.current();
    } catch (error) {
      if (actionGeneration !== generation.current || stateRef.current.sessionKey !== sessionKey) return;
      const uncertain = isUncertainEnqueueError(error);
      updateState((current) => ({
        ...current,
        submissions: upsertSubmission(current.submissions, {
          clientRequestId,
          files,
          fileNames: files.map((file) => file.name),
          status: uncertain ? "uncertain" : "failed",
          error: errorMessage(error, uncertain
            ? "Die Übertragung ist unklar. Prüfen Sie den Status oder senden Sie dieselbe Auswahl erneut."
            : "Der Upload konnte nicht eingereiht werden."),
        }),
      }));
      wakePoll.current();
    }
  }, [publishCompletion, sessionKey, updateState]);

  const enqueue = useCallback((files: readonly File[]) => {
    const selected = Array.from(files);
    if (!selected.length) return;
    void submit(selected, createClientRequestId());
  }, [submit]);

  const retrySubmission = useCallback((clientRequestId: string) => {
    const submission = stateRef.current.submissions.find((item) => item.clientRequestId === clientRequestId);
    if (submission) void submit(submission.files, submission.clientRequestId);
  }, [submit]);

  const dismissSubmission = useCallback((clientRequestId: string) => {
    updateState((current) => ({
      ...current,
      submissions: current.submissions.filter((submission) => submission.clientRequestId !== clientRequestId),
    }));
  }, [updateState]);

  const runJobAction = useCallback(async (
    job: OfferUploadJob,
    action: () => Promise<{ job: OfferUploadJob }>,
  ) => {
    if (stateRef.current.actionIds.includes(job.id)) return;
    const actionGeneration = generation.current;
    updateState((current) => ({
      ...current,
      actionIds: current.actionIds.includes(job.id) ? current.actionIds : [...current.actionIds, job.id],
      error: null,
    }));
    try {
      const response = await action();
      if (actionGeneration !== generation.current || stateRef.current.sessionKey !== sessionKey) return;
      const updated = parseJob(response.job);
      updateState((current) => ({ ...current, jobs: upsertJob(current.jobs, updated) }));
      publishCompletion(updated);
      wakePoll.current();
    } catch (error) {
      if (actionGeneration !== generation.current || stateRef.current.sessionKey !== sessionKey) return;
      updateState((current) => ({
        ...current,
        error: errorMessage(error, "Der Upload-Auftrag konnte nicht aktualisiert werden."),
      }));
      wakePoll.current();
    } finally {
      if (actionGeneration === generation.current && stateRef.current.sessionKey === sessionKey) {
        updateState((current) => ({
          ...current,
          actionIds: current.actionIds.filter((id) => id !== job.id),
        }));
      }
    }
  }, [publishCompletion, sessionKey, updateState]);

  const confirm = useCallback((job: OfferUploadJob) => {
    if (!job.confirmation_revision || !job.duplicates?.length) return;
    void runJobAction(job, () => confirmOfferUploadJob(
      job.id,
      job.confirmation_revision!,
      job.duplicates!.map((duplicate) => duplicate.remove),
    ));
  }, [runJobAction]);

  const cancel = useCallback((job: OfferUploadJob) => {
    if (job.status !== "queued" && job.status !== "awaiting_confirmation") return;
    void runJobAction(job, () => cancelOfferUploadJob(job.id));
  }, [runJobAction]);

  const refresh = useCallback(() => wakePoll.current(), []);
  const published = state.sessionKey === sessionKey ? state : initialState(sessionKey);

  return useMemo(() => ({
    jobs: published.jobs,
    submissions: published.submissions,
    loading: published.loading,
    stale: published.stale,
    error: published.error,
    enqueue,
    retrySubmission,
    dismissSubmission,
    confirm,
    cancel,
    refresh,
    isActing: (jobId: string) => published.actionIds.includes(jobId),
  }), [cancel, confirm, dismissSubmission, enqueue, published, refresh, retrySubmission]);
}

function initialState(sessionKey: number | string | null): OfferUploadJobsState {
  return {
    sessionKey,
    jobs: [],
    submissions: [],
    loading: true,
    stale: false,
    error: null,
    actionIds: [],
  };
}

function upsertJob(jobs: readonly OfferUploadJob[], job: OfferUploadJob): OfferUploadJob[] {
  return [job, ...jobs.filter((candidate) => candidate.id !== job.id)];
}

function upsertSubmission(
  submissions: readonly LocalOfferUploadSubmission[],
  submission: LocalOfferUploadSubmission,
): LocalOfferUploadSubmission[] {
  return [submission, ...submissions.filter((candidate) => candidate.clientRequestId !== submission.clientRequestId)];
}

function parseJobs(value: unknown): OfferUploadJob[] {
  if (!Array.isArray(value)) throw new Error("Die Upload-Warteschlange enthält keine gültige Jobliste.");
  return value.map(parseJob).sort((left, right) => (
    new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  ));
}

function parseJob(value: unknown): OfferUploadJob {
  if (!value || typeof value !== "object") throw new Error("Ein Upload-Auftrag ist ungültig.");
  const job = value as Partial<OfferUploadJob>;
  if (
    typeof job.id !== "string"
    || typeof job.client_request_id !== "string"
    || !JOB_STATUSES.has(job.status as OfferUploadJobStatus)
    || !Array.isArray(job.file_names)
    || !job.file_names.every((name) => typeof name === "string")
    || typeof job.created_at !== "string"
    || typeof job.updated_at !== "string"
  ) {
    throw new Error("Ein Upload-Auftrag ist unvollständig.");
  }
  if (job.duplicates !== undefined && job.duplicates !== null && (
    !Array.isArray(job.duplicates)
    || !job.duplicates.every((duplicate) => duplicate
      && typeof duplicate.offer_number === "string"
      && typeof duplicate.keep === "string"
      && typeof duplicate.remove === "string")
  )) {
    throw new Error("Die Dublettenliste eines Upload-Auftrags ist ungültig.");
  }
  return job as OfferUploadJob;
}

function createClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function isUncertainEnqueueError(error: unknown): boolean {
  return !(error instanceof PriceComparisonError) || error.status >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

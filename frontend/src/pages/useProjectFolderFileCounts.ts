import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ProjectFolder } from "../types/site";

export function useProjectFolderFileCounts(siteId: number, folders: ProjectFolder[]) {
  const [state, setState] = useState<{ siteId: number; counts: Record<string, number | null> }>({ siteId, counts: {} });
  const seed = Object.fromEntries(folders.filter(f => typeof f.file_count === "number").map(f => [f.folder_key, f.file_count!]));

  useEffect(() => {
    let active = true;
    let loading = false;
    let changedDuringLoad = false;
    let lastStarted = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ siteId, counts: seed });
    async function refresh() {
      if (!active || loading || document.visibilityState !== "visible") return;
      clearTimeout(timer);
      loading = true;
      lastStarted = Date.now();
      let refreshing = false;
      const queue = [...folders];
      async function worker() {
        while (active && queue.length) {
          const folder = queue.shift()!;
          let count: number | null = null;
          let forbidden = false;
          try {
            const response = await api.projectFolderFileCount(siteId, folder.folder_key);
            if (typeof response.file_count === "number" && Number.isInteger(response.file_count) && response.file_count >= 0) count = response.file_count;
            refreshing ||= response.refreshing === true;
          } catch (error) {
            const status = (error as { status?: number })?.status;
            forbidden = status === 401 || status === 403 || status === 404;
          }
          if (active) setState(current => ({ siteId, counts: {
            ...(current.siteId === siteId ? current.counts : {}),
            [folder.folder_key]: forbidden ? null : count ?? (current.siteId === siteId ? current.counts[folder.folder_key] : null) ?? null,
          } }));
        }
      }
      await Promise.all([worker(), worker()]);
      loading = false;
      if (active && folders.length) timer = setTimeout(() => void refresh(), changedDuringLoad ? 0 : refreshing ? 3000 : 300000);
      changedDuringLoad = false;
    }
    const onVisible = () => { if (Date.now() - lastStarted > 15000) void refresh(); };
    const onFilesChanged = () => { if (loading) changedDuringLoad = true; else void refresh(); };
    void refresh();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("project-files-changed", onFilesChanged);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("project-files-changed", onFilesChanged);
    };
  }, [siteId, folders]);

  return { ...seed, ...(state.siteId === siteId ? state.counts : {}) };
}

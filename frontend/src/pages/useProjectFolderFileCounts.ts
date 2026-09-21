import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ProjectFolder } from "../types/site";

export function useProjectFolderFileCounts(siteId: number, folders: ProjectFolder[]) {
  const [counts, setCounts] = useState<Record<string, number | null>>({});

  useEffect(() => {
    let active = true;
    let generation = 0;
    let loading = false;
    async function refresh() {
      if (loading) return;
      loading = true;
      const request = ++generation;
      setCounts({});
      const queue = [...folders];
      async function worker() {
        while (active && request === generation && queue.length) {
          const folder = queue.shift()!;
          let count: number | null = null;
          try {
            const response = await api.projectFolderFileCount(siteId, folder.folder_key);
            if (Number.isInteger(response.file_count) && response.file_count >= 0) count = response.file_count;
          } catch {
            // Unknown is not zero; an inaccessible subtree must not produce a partial total.
          }
          if (active && request === generation) {
            setCounts(current => ({ ...current, [folder.folder_key]: count }));
          }
        }
      }
      await Promise.all([worker(), worker()]);
      loading = false;
    }
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    void refresh();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      generation++;
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [siteId, folders]);

  return counts;
}

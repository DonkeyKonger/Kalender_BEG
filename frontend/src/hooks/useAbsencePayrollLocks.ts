import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { absencePayrollMonths } from "../lib/absencePayrollLock";
import type { AbsencePayrollRange } from "../lib/absencePayrollLock";
import type { PayrollMonthLockStatus } from "../types/payrollMonth";

export function useAbsencePayrollLocks(ranges: AbsencePayrollRange[]) {
  const requestKey = [...new Set(ranges.flatMap((range) => absencePayrollMonths(range.start_date, range.end_date)))].sort().join(",");
  const [statuses, setStatuses] = useState<Record<string, PayrollMonthLockStatus>>({});
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    setReadyKey(null);
    setError(false);
    void Promise.all(requestKey.split(",").filter(Boolean).map((key) => {
      const [year, month] = key.split("-").map(Number);
      return api.payrollMonthLockStatus({ year, month, signal: controller.signal });
    })).then((periods) => {
      if (controller.signal.aborted) return;
      setStatuses(Object.fromEntries(periods.map((period) => [
        `${period.year}-${String(period.month).padStart(2, "0")}`, period,
      ])));
      setReadyKey(requestKey);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    });
    return () => controller.abort();
  }, [requestKey, revision]);

  useEffect(() => {
    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") setRevision((value) => value + 1);
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, []);

  return { statuses: readyKey === requestKey && !error ? statuses : {}, error, refresh };
}

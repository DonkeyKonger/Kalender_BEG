import { createContext, useContext } from "react";

export type DashboardMessageCountContextValue = {
  count: number;
  initialized: boolean;
  refresh: () => void;
};

export const DashboardMessageCountContext = createContext<DashboardMessageCountContextValue | null>(null);

export function useDashboardMessageCount(): DashboardMessageCountContextValue {
  const context = useContext(DashboardMessageCountContext);
  if (context === null) {
    throw new Error("useDashboardMessageCount muss innerhalb des DashboardMessageCountProvider verwendet werden.");
  }
  return context;
}

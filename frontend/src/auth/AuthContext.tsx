import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { api, ApiError } from "../lib/api";
import type { CurrentUser } from "../types/auth";

type AuthStatus = "loading" | "authenticated" | "anonymous";

type AuthContextValue = {
  user: CurrentUser | null;
  status: AuthStatus;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  const loadCurrentUser = useCallback(async () => {
    if (!localStorage.getItem("kb_access_token")) {
      setStatus("anonymous");
      return;
    }

    try {
      const currentUser = await api.me();
      setUser(currentUser);
      setStatus("authenticated");
    } catch (error) {
      localStorage.removeItem("kb_access_token");
      setUser(null);
      setStatus("anonymous");
      if (!(error instanceof ApiError && error.status === 401)) {
        console.error(error);
      }
    }
  }, []);

  useEffect(() => {
    void loadCurrentUser();
  }, [loadCurrentUser]);

  const login = useCallback(async (username: string, password: string) => {
    const token = await api.login(username, password);
    localStorage.setItem("kb_access_token", token.access_token);
    const currentUser = await api.me();
    setUser(currentUser);
    setStatus("authenticated");
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      localStorage.removeItem("kb_access_token");
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo(
    () => ({ user, status, login, logout }),
    [user, status, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth muss innerhalb von AuthProvider verwendet werden.");
  }
  return context;
}

import type { OfficePagePermission, UserRole } from "./auth";

export type AdminUser = {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  must_change_password: boolean;
  last_admin_password_plain: string | null;
  office_page_permissions: OfficePagePermission[];
  person_id: number | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AdminUserCreate = {
  username: string;
  display_name: string;
  password: string;
  role: UserRole;
  is_active: boolean;
  person_id: number | null;
  office_page_permissions: OfficePagePermission[];
};

export type AdminUserUpdate = {
  username?: string;
  display_name?: string;
  role?: UserRole;
  is_active?: boolean;
  person_id?: number | null;
  office_page_permissions?: OfficePagePermission[];
};

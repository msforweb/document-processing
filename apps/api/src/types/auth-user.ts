export type UserRole = 'ADMIN' | 'REVIEWER' | 'OPERATOR';

export interface AuthUser {
  id: string;
  organizationId: string;
  email: string;
  role: UserRole;
}

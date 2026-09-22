export declare const documentProcessingVersion = "0.1.0";
export type UserRole = 'ADMIN' | 'REVIEWER' | 'OPERATOR';
export interface AuthUser {
    id: string;
    organizationId: string;
    email: string;
    role: UserRole;
}

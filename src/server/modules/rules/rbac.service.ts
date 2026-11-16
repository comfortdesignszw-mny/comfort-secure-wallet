import {
  Permission,
  RbacRuleRecord,
  ROLE_PERMISSIONS,
  Role,
} from '../../../shared/types.ts';
import { dbStore } from '../../db/store.ts';
import { getSuperAdminEmail } from '../../config/env.ts';

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  [Role.USER]: 'Wallet customer with access only to own KYC, balances, transfers, deposits, withdrawals, and statements.',
  [Role.SUPPORT_AGENT]: 'Customer support representative (read-only user/txn lookup, support notes, security resets).',
  [Role.KYC_OFFICER]: 'Identity verification officer responsible for reviewing and deciding KYC submissions.',
  [Role.FINANCE_MAKER]: 'First-line treasury operator for Maker approval on deposits/withdrawals and payout execution.',
  [Role.FINANCE_CHECKER]: 'Independent second-line treasury authorizer (Checker != Maker) and reconciliation resolver.',
  [Role.COMPLIANCE_OFFICER]: 'AML/CFT compliance specialist with freeze/unfreeze, risk resolution, and audit log inspection.',
  [Role.AUDITOR]: 'Read-only assurance role across transactions, immutable ledger journals, approvals, and audit trails.',
  [Role.SUPER_ADMIN]: 'Root governance authority with full permissions, RBAC oversight, and staff onboarding/promotion control.',
};

class RbacService {
  /**
   * Populate and persist all RBAC role-permission rules into the database on startup
   * (executed in both development and production so enforcement is always DB-backed).
   */
  ensureRbacRulesInDb(actorId = 'system'): RbacRuleRecord[] {
    const now = new Date().toISOString();
    const results: RbacRuleRecord[] = [];
    for (const role of Object.values(Role)) {
      if (!dbStore.rbacRules.has(role)) {
        const record: RbacRuleRecord = {
          role,
          permissions: [...ROLE_PERMISSIONS[role]],
          description: ROLE_DESCRIPTIONS[role],
          updatedAt: now,
          updatedBy: actorId,
        };
        dbStore.rbacRules.set(role, record);
        dbStore.mirrorDoc('rbac_rules', role, record as unknown as Record<string, unknown>);
      }
      results.push(dbStore.rbacRules.get(role)!);
    }
    return results;
  }

  listRules(): RbacRuleRecord[] {
    this.ensureRbacRulesInDb();
    return [...dbStore.rbacRules.values()];
  }

  getPermissionsForRole(role: Role): Permission[] {
    this.ensureRbacRulesInDb();
    return dbStore.rbacRules.get(role)?.permissions ?? [];
  }

  hasPermission(role: Role, permission: Permission): boolean {
    const perms = this.getPermissionsForRole(role);
    return perms.includes(permission);
  }

  isDesignatedSuperAdminEmail(email: string | null | undefined): boolean {
    if (!email) return false;
    return email.trim().toLowerCase() === getSuperAdminEmail();
  }
}

export const rbacService = new RbacService();

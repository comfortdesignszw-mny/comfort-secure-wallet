import { randomUUID } from 'node:crypto';
import { KycDocumentRecord, KycStatus, NotificationChannel, UserProfileRecord } from '../../../shared/types.ts';
import { dbStore } from '../../db/store.ts';
import { decryptField, encryptBuffer, encryptField, signStorageKey } from '../../security/crypto.ts';
import { recordAuditLog } from '../../security/audit.ts';
import { accountsService } from '../accounts/accounts.service.ts';
import { notificationService } from '../notifications/notifications.service.ts';

class KycService {
  private storePrivateDocument(userId: string, prefix: string, dataUrl: string): { storageKey: string; mimeType: string } {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    const mimeType = match ? match[1] : 'image/png';
    const rawBuffer = match ? Buffer.from(match[2], 'base64') : Buffer.from(dataUrl, 'utf8');
    const storageKey = `private/${prefix}/${userId}/${randomUUID()}`;
    dbStore.privateBlobs.set(storageKey, {
      storageKey,
      mimeType,
      encryptedPayload: encryptBuffer(rawBuffer),
      ownerUserId: userId,
      createdAt: new Date().toISOString(),
    });
    return { storageKey, mimeType };
  }

  async submitKyc(
    userId: string,
    payload: {
      fullName: string;
      dateOfBirth: string;
      nationalIdNumber: string;
      address: string;
      country: string;
      documentType: 'NATIONAL_ID' | 'PASSPORT';
      idDocumentDataUrl: string;
      selfieDataUrl: string;
    },
  ) {
    const user = dbStore.users.get(userId);
    if (!user) throw new Error('User not found');

    const now = new Date().toISOString();
    const profile: UserProfileRecord = {
      userId,
      fullName: payload.fullName,
      dateOfBirth: payload.dateOfBirth,
      nationalIdEncrypted: encryptField(payload.nationalIdNumber),
      address: payload.address,
      country: payload.country.toUpperCase(),
      updatedAt: now,
    };
    dbStore.userProfiles.set(userId, profile);

    const idBlob = this.storePrivateDocument(userId, 'kyc-id', payload.idDocumentDataUrl);
    const selfieBlob = this.storePrivateDocument(userId, 'kyc-selfie', payload.selfieDataUrl);

    const idDoc: KycDocumentRecord = {
      id: `doc_${randomUUID()}`,
      userId,
      type: payload.documentType,
      storageKey: idBlob.storageKey,
      mimeType: idBlob.mimeType,
      status: KycStatus.PENDING,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt: now,
    };
    const selfieDoc: KycDocumentRecord = {
      id: `doc_${randomUUID()}`,
      userId,
      type: 'SELFIE',
      storageKey: selfieBlob.storageKey,
      mimeType: selfieBlob.mimeType,
      status: KycStatus.PENDING,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt: now,
    };
    dbStore.kycDocuments.set(idDoc.id, idDoc);
    dbStore.kycDocuments.set(selfieDoc.id, selfieDoc);

    user.kycStatus = KycStatus.PENDING;

    recordAuditLog({
      actorId: userId,
      actorType: 'USER',
      action: 'KYC_SUBMITTED',
      entity: `user:${userId}`,
      after: { kycStatus: KycStatus.PENDING, documentType: payload.documentType },
    });

    return { kycStatus: user.kycStatus, documents: [idDoc, selfieDoc] };
  }

  getStatusForUser(userId: string) {
    const user = dbStore.users.get(userId);
    if (!user) throw new Error('User not found');
    const profile = dbStore.userProfiles.get(userId);
    const docs = [...dbStore.kycDocuments.values()].filter((d) => d.userId === userId);
    return {
      kycStatus: user.kycStatus,
      kycTier: user.kycTier,
      profile: profile
        ? {
            fullName: profile.fullName,
            dateOfBirth: profile.dateOfBirth,
            nationalIdMasked: maskNationalId(decryptField(profile.nationalIdEncrypted)),
            address: profile.address,
            country: profile.country,
          }
        : null,
      documents: docs.map((d) => ({
        id: d.id,
        type: d.type,
        status: d.status,
        rejectionReason: d.rejectionReason,
        createdAt: d.createdAt,
      })),
    };
  }

  listKycQueueForOfficer() {
    const pendingUsers = [...dbStore.users.values()].filter(
      (u) => u.kycStatus === KycStatus.PENDING || u.kycStatus === KycStatus.NEEDS_MORE_INFO,
    );
    return pendingUsers.map((u) => {
      const profile = dbStore.userProfiles.get(u.id);
      const docs = [...dbStore.kycDocuments.values()]
        .filter((d) => d.userId === u.id)
        .map((d) => ({
          ...d,
          signedUrl: signStorageKey(d.storageKey, 60).url,
        }));
      return {
        userId: u.id,
        email: u.email,
        phone: u.phone,
        kycStatus: u.kycStatus,
        createdAt: u.createdAt,
        profile: profile
          ? {
              fullName: profile.fullName,
              dateOfBirth: profile.dateOfBirth,
              nationalIdNumber: decryptField(profile.nationalIdEncrypted),
              address: profile.address,
              country: profile.country,
            }
          : null,
        documents: docs,
      };
    });
  }

  async decideKyc(params: {
    targetUserId: string;
    officerId: string;
    decision: 'APPROVED' | 'REJECTED' | 'NEEDS_MORE_INFO';
    reason?: string;
  }) {
    const user = dbStore.users.get(params.targetUserId);
    if (!user) throw new Error('User not found');
    const before = { kycStatus: user.kycStatus, kycTier: user.kycTier };
    const now = new Date().toISOString();

    if (params.decision === 'APPROVED') {
      user.kycStatus = KycStatus.APPROVED;
      user.kycTier = Math.max(1, user.kycTier);
      for (const doc of dbStore.kycDocuments.values()) {
        if (doc.userId === params.targetUserId && doc.status === KycStatus.PENDING) {
          doc.status = KycStatus.APPROVED;
          doc.reviewedBy = params.officerId;
          doc.reviewedAt = now;
        }
      }
      accountsService.provisionWalletsForApprovedUser(user.id);
    } else {
      user.kycStatus = params.decision === 'REJECTED' ? KycStatus.REJECTED : KycStatus.NEEDS_MORE_INFO;
      for (const doc of dbStore.kycDocuments.values()) {
        if (doc.userId === params.targetUserId && doc.status === KycStatus.PENDING) {
          doc.status = user.kycStatus;
          doc.reviewedBy = params.officerId;
          doc.reviewedAt = now;
          doc.rejectionReason = params.reason || 'Verification check did not pass.';
        }
      }
    }

    await notificationService.enqueue({
      userId: user.id,
      channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL, NotificationChannel.SMS],
      template: 'KYC_DECISION_v1',
      body:
        params.decision === 'APPROVED'
          ? 'Your identity verification is approved. Your 10-digit Comfort Secure Wallet account is now active.'
          : `KYC status updated to ${params.decision}: ${params.reason || 'Please review your submission.'}`,
    });

    recordAuditLog({
      actorId: params.officerId,
      actorType: 'ADMIN',
      action: `KYC_${params.decision}`,
      entity: `user:${user.id}`,
      before,
      after: { kycStatus: user.kycStatus, kycTier: user.kycTier, reason: params.reason || null },
    });

    return {
      userId: user.id,
      kycStatus: user.kycStatus,
      kycTier: user.kycTier,
      accounts: user.kycStatus === KycStatus.APPROVED ? accountsService.listUserAccounts(user.id) : [],
    };
  }
}

function maskNationalId(raw: string): string {
  if (raw.length <= 4) return '••••';
  return `${raw.slice(0, 2)}${'•'.repeat(raw.length - 4)}${raw.slice(-2)}`;
}

export const kycService = new KycService();

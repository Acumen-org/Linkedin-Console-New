import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInvite } from '../src/bridge/invites.ts';

const NORM = 'https://www.linkedin.com/voyager/api/growth/normInvitations';

test('a non-invite URL is ignored', () => {
  assert.equal(parseInvite('POST', 'https://www.linkedin.com/voyager/api/messaging/x', '{}'), null);
});

test('invite-create (normInvitations) → sent, with member urn + note', () => {
  const body = JSON.stringify({
    invitee: { 'com.linkedin.voyager.growth.invitation.InviteeProfile': { profileId: 'ACoAABcdef' } },
    message: 'Hi there',
  });
  assert.deepEqual(parseInvite('POST', NORM, body), {
    action: 'sent',
    memberUrn: 'urn:li:fsd_profile:ACoAABcdef',
    note: 'Hi there',
  });
});

test('dash MemberRelationships with an explicit invitee URN → sent (no note)', () => {
  const url = 'https://www.linkedin.com/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2';
  const body = JSON.stringify({ inviteeProfileUrn: 'urn:li:fsd_profile:ACoAAXYZ' });
  assert.deepEqual(parseInvite('POST', url, body), { action: 'sent', memberUrn: 'urn:li:fsd_profile:ACoAAXYZ', note: null });
});

test('a DELETE to an invitation endpoint → withdrawn (urn read from the path)', () => {
  const url = 'https://www.linkedin.com/voyager/api/relationships/invitations/urn:li:fsd_profile:ACoAAWD';
  assert.deepEqual(parseInvite('DELETE', url, null), { action: 'withdrawn', memberUrn: 'urn:li:fsd_profile:ACoAAWD', note: null });
});

test('an invite call with no identifiable invitee → null', () => {
  assert.equal(parseInvite('POST', NORM, JSON.stringify({ something: 'else' })), null);
});

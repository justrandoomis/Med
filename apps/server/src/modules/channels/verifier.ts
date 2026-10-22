// P1-T1's JoinTokenVerifier, implemented by the channels module (P1-T4 step 1; ARCHITECTURE_DELTA §7.2; PRD Q2/Q3):
// POST /api/auth/register creates an account only with a valid class code or invite-link token. `verify` checks the
// proof and reserves one use of it before the account exists; `redeem` files the new account's membership;
// `release` gives the use back when the account could not be created (a taken name). An invitation id is no proof
// (invitations go to existing accounts — review W2-step0 R3) and is refused like a wrong code.
import type { ChannelMembershipView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import type { JoinTokenVerifier } from '../auth';
import { channelsOf, type ChannelJoinTicket } from './service';

export function createChannelJoinVerifier(ctx: AppContext): JoinTokenVerifier {
  const channels = channelsOf(ctx);
  return {
    verify: (join, ip) => channels.reserveForRegistration(join, ip),
    redeem: (ticket, userId, ip): ChannelMembershipView | null => channels.redeemRegistration(ticket as ChannelJoinTicket, userId, ip),
    release: (ticket) => channels.releaseRegistration(ticket as ChannelJoinTicket),
  };
}

import { NextResponse } from "next/server";
import { AuthError } from "../../../../../../lib/server/authz/errors";
import { prisma } from "../../../../../../lib/server/db";
import { EVENT_GUEST_COOKIE, eventParticipantApiPath, issueEventGuestSession, joinMobileEvent } from "../../../../../../lib/server/events/entries";
import { EventError, eventMutation } from "../../../../../../lib/server/events/errors";
import { readEventJson } from "../../../../../../lib/server/events/http";
import { noStore, readCookie, sessionToken } from "../../../../../../lib/server/http/route";
export const POST = eventMutation(async(req: Request, { params }: { params: Promise<{ eventId: string; action: string }> }) => {
  const {eventId,action}=await params, body=req.body?await readEventJson(req):{},guestToken=readCookie(req,EVENT_GUEST_COOKIE);
  if(action==="guest-session") {
    if(Object.keys(body).length)throw new EventError(400,"invalid_entry_input");
    const issued=await issueEventGuestSession(prisma,eventId,guestToken),response=noStore(NextResponse.json({guestSessionReady:true,expiresAt:issued.expiresAt}));
    response.cookies.set(EVENT_GUEST_COOKIE,issued.token,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:eventParticipantApiPath(eventId.toLowerCase()),expires:issued.expiresAt});
    return response;
  }
  if(action!=="join")throw new AuthError(404,"not_found");
  return noStore(NextResponse.json(await joinMobileEvent(prisma,eventId,body,{buyerToken:sessionToken(req,"buyer"),guestToken})));
});

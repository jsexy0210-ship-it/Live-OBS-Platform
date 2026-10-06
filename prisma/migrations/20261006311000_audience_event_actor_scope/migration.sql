-- 참가 회원은 실행자·공개 행위자가 아니다. 회원 탈퇴 정보가 불변 운영 이력에 들어오지 않게 한다.
ALTER TABLE "AudienceEventRound" ADD CONSTRAINT "AudienceEventRound_actor_scope_check" CHECK ("actorType" <> 'BUYER');
ALTER TABLE "AudienceEventPublication" ADD CONSTRAINT "AudienceEventPublication_actor_scope_check" CHECK ("actorType" <> 'BUYER');

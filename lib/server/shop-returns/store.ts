import type { Prisma, PrismaClient } from "@prisma/client";
import type { ReviewImage } from "../product-reviews/image";

// 교환·반품 신청 사진 저장소. 리뷰 사진과 같은 어댑터 방식(대표님 결정 2026-10-04: 사진은 별도 저장소로 옮긴다):
// 사진 바이트의 쓰기·읽기·지우기는 이 어댑터 뒤에서만 한다. 메타데이터(종류·크기·가로세로·신청 연결)는 ReturnRequestImage 행이 갖는다.
// 지금 구현은 DB 어댑터 하나(바이트를 행의 data 열에 둔다). 버킷 어댑터와 이전은 후속 PR에서 같은 인터페이스로 넣는다.
// 버킷 어댑터를 넣을 때 주의: 행이 외래 키 CASCADE(회원·신청 삭제)로 지워지는 경로는 어댑터를 거치지 않으므로 그 경로의 객체 정리를 따로 둔다.
type Db = PrismaClient | Prisma.TransactionClient;
export type StoredImage = { data: Uint8Array; contentType: string };
export type NewImage = { sellerId: string; buyerMemberId: string; image: ReviewImage };

export interface ReturnImageStore {
  put(tx: Prisma.TransactionClient, img: NewImage): Promise<{ id: string; width: number; height: number }>;
  get(db: Db, where: Prisma.ReturnRequestImageWhereInput): Promise<StoredImage | null>;
  delete(tx: Prisma.TransactionClient, where: Prisma.ReturnRequestImageWhereInput): Promise<number>;
}

export const dbReturnImageStore: ReturnImageStore = {
  async put(tx, { sellerId, buyerMemberId, image }) {
    return tx.returnRequestImage.create({
      data: { sellerId, buyerMemberId, data: new Uint8Array(image.data), contentType: image.type, byteSize: image.data.length, width: image.width, height: image.height },
      select: { id: true, width: true, height: true },
    });
  },
  async get(db, where) {
    return db.returnRequestImage.findFirst({ where, select: { data: true, contentType: true } });
  },
  async delete(tx, where) {
    return (await tx.returnRequestImage.deleteMany({ where })).count;
  },
};

export const returnImageStore: ReturnImageStore = dbReturnImageStore;

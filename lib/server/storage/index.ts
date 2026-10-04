import type { Prisma, PrismaClient } from "@prisma/client";
import { dbStorage } from "./db";
import { kakaoStorage } from "./kakao";

// 공통 이미지 저장소(대표님 결정 2026-10-04: 카카오 오브젝트 스토리지로 옮길 수 있게 하되 지금은 DB 저장).
// 업로드 경로는 바이트를 검사한 뒤 여기로만 저장하고, 돌려받은 storageKey를 자기 표에 둔다. 화면에 주는 주소는 저장 방식과 상관없는
// 우리 경로(/api/.../images/[id])이고, 그 경로가 getImage로 바이트를 꺼내 응답한다. 저장 방식은 IMAGE_STORAGE(기본 db).
// 드라이버를 추가할 때(인프라 전담): 같은 ImageStorage를 구현하고 아래 표에 넣는다. storageKey는 "드라이버:값" 모양이라
// 옮기는 동안 두 드라이버 키가 섞여 있어도 키만 보고 어느 드라이버인지 안다.
export type ImageContentType = "image/png" | "image/jpeg" | "image/webp";
export type StoredImageInput = { sellerId: string; bytes: Buffer; contentType: ImageContentType; sha256: string };
export type StoredImageData = { data: Uint8Array; contentType: string; sha256: string };
type Db = PrismaClient | Prisma.TransactionClient;

export interface ImageStorage {
  readonly name: string;
  // 같은 트랜잭션(tx) 안에서 저장해, 업로드 기록이 롤백되면 바이트도 남지 않게 한다(DB 드라이버). 외부 저장소는 커밋 뒤 정리 작업이 필요하다.
  putImage(tx: Db, input: StoredImageInput): Promise<string>;
  // sellerId가 다르면 null(다른 판매자 키로 읽지 못하게)
  getImage(db: Db, storageKey: string, sellerId: string): Promise<StoredImageData | null>;
  deleteImage(tx: Db, storageKey: string, sellerId: string): Promise<void>;
}

const DRIVERS: Record<string, ImageStorage> = { db: dbStorage, kakao: kakaoStorage };

// 새로 저장할 드라이버. 모르는 값이면 저장하지 않고 오류(조용히 다른 곳에 저장하지 않음).
export function imageStorage(): ImageStorage {
  const name = process.env.IMAGE_STORAGE || "db";
  const driver = DRIVERS[name];
  if (!driver) throw new Error(`unknown IMAGE_STORAGE: ${name}`);
  return driver;
}

// 읽기·지우기는 키 앞부분의 드라이버로
function driverOf(storageKey: string): ImageStorage {
  const driver = DRIVERS[storageKey.slice(0, storageKey.indexOf(":"))];
  if (!driver) throw new Error("unknown storage key");
  return driver;
}

export const putImage = (tx: Db, input: StoredImageInput) => imageStorage().putImage(tx, input);
export const getImage = (db: Db, storageKey: string, sellerId: string) => driverOf(storageKey).getImage(db, storageKey, sellerId);
export const deleteImage = (tx: Db, storageKey: string, sellerId: string) => driverOf(storageKey).deleteImage(tx, storageKey, sellerId);

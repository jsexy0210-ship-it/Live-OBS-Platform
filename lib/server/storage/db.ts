import type { Prisma, PrismaClient } from "@prisma/client";
import type { ImageStorage } from "./index";

// DB 드라이버(IMAGE_STORAGE=db): StoredImage 표에 바이트를 둔다. storageKey = "db:" + StoredImage.id.
// 크기(5MB)·형식·해시 CHECK는 마이그레이션 20261004250000_product_images.
type Db = PrismaClient | Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (storageKey: string) => {
  const id = storageKey.startsWith("db:") ? storageKey.slice(3) : "";
  return UUID.test(id) ? id : null;
};

export const dbStorage: ImageStorage = {
  name: "db",
  async putImage(tx, { sellerId, bytes, contentType, sha256 }) {
    const row = await (tx as Db).storedImage.create({
      data: { sellerId, data: new Uint8Array(bytes), contentType, byteSize: bytes.length, sha256 },
      select: { id: true },
    });
    return `db:${row.id}`;
  },
  async getImage(db, storageKey, sellerId) {
    const id = idOf(storageKey);
    if (!id) return null;
    return (db as Db).storedImage.findFirst({ where: { id, sellerId }, select: { data: true, contentType: true, sha256: true } });
  },
  async deleteImage(tx, storageKey, sellerId) {
    const id = idOf(storageKey);
    if (id) await (tx as Db).storedImage.deleteMany({ where: { id, sellerId } });
  },
};

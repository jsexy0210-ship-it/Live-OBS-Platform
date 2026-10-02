/*
  Warnings:

  - Added the required column `ciHash` to the `PasswordResetGrant` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "PasswordResetGrant" ADD COLUMN     "ciHash" TEXT NOT NULL;

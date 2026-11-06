"use client";
import type { Flash } from "@/lib/client";
import { Notice } from "./ui";

export function FlashNotice({ flash }: { flash: Flash }) { return flash ? <Notice kind={flash.kind}>{flash.text}</Notice> : null; }

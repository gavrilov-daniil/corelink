import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

/**
 * Управление профилями подписки и каналами — то, что в старой сети правилось
 * руками в VARIANTS внутри subgen.py и требовало перезапуска контейнера.
 */
@Controller("api/admin")
export class ProfilesAdminController {
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  @Get("profiles")
  async listProfiles() {
    const profiles = await this.db
      .select()
      .from(schema.profile)
      .where(eq(schema.profile.orgId, this.cfg.defaultOrgId))
      .orderBy(schema.profile.sortOrder);

    const links = await this.db
      .select({ pc: schema.profileChannel, ch: schema.channel })
      .from(schema.profileChannel)
      .innerJoin(schema.channel, eq(schema.profileChannel.channelId, schema.channel.id))
      .where(eq(schema.profileChannel.orgId, this.cfg.defaultOrgId));

    return profiles.map((p) => ({
      ...p,
      channels: links
        .filter((l) => l.pc.profileId === p.id)
        .sort((a, b) => a.pc.tier - b.pc.tier || a.pc.sortOrder - b.pc.sortOrder)
        .map((l) => ({
          id: l.ch.id,
          tag: l.ch.newTag ?? l.ch.tag,
          kind: l.ch.kind,
          cc: l.ch.cc,
          tier: l.pc.tier,
          sortOrder: l.pc.sortOrder,
        })),
    }));
  }

  @Post("profiles")
  async createProfile(
    @Body() body: { remark: string; sortOrder?: number; isAuto?: boolean; ruSplit?: boolean },
  ) {
    const [row] = await this.db
      .insert(schema.profile)
      .values({
        orgId: this.cfg.defaultOrgId,
        remark: body.remark,
        sortOrder: body.sortOrder ?? 0,
        isAuto: body.isAuto ?? false,
        ruSplit: body.ruSplit ?? true,
      })
      .returning();
    return row;
  }

  /**
   * ruSplit=false нужен профилям «Россия» / «Белые списки»: там РФ-трафик должен
   * идти ЧЕРЕЗ туннель, а не мимо него.
   */
  @Patch("profiles/:id")
  async updateProfile(
    @Param("id") id: string,
    @Body() body: { remark?: string; sortOrder?: number; isAuto?: boolean; ruSplit?: boolean },
  ) {
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) if (v !== undefined) values[k] = v;
    if (Object.keys(values).length === 0) throw new NotFoundException("нечего обновлять");

    const [row] = await this.db
      .update(schema.profile)
      .set(values)
      .where(and(eq(schema.profile.orgId, this.cfg.defaultOrgId), eq(schema.profile.id, id)))
      .returning();
    if (!row) throw new NotFoundException("профиль не найден");
    return row;
  }

  @Delete("profiles/:id")
  async deleteProfile(@Param("id") id: string) {
    await this.db.delete(schema.profileChannel).where(eq(schema.profileChannel.profileId, id));
    await this.db
      .delete(schema.profile)
      .where(and(eq(schema.profile.orgId, this.cfg.defaultOrgId), eq(schema.profile.id, id)));
    return { ok: true };
  }

  /** Привязка канала к профилю. tier — эшелон: 1 основной, 2 резерв, 3 последний резерв. */
  @Post("profiles/:id/channels")
  async attachChannel(
    @Param("id") profileId: string,
    @Body() body: { channelId: string; tier?: number; sortOrder?: number },
  ) {
    // выдача читает эшелоны 1..3 — канал с другим тиром молча выпал бы из подписки
    if (body.tier !== undefined && ![1, 2, 3].includes(body.tier)) {
      throw new BadRequestException("tier: допустимы 1, 2 или 3");
    }
    const [row] = await this.db
      .insert(schema.profileChannel)
      .values({
        orgId: this.cfg.defaultOrgId,
        profileId,
        channelId: body.channelId,
        tier: body.tier ?? 1,
        sortOrder: body.sortOrder ?? 0,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? { ok: true, alreadyLinked: true };
  }

  @Delete("profiles/:id/channels/:channelId")
  async detachChannel(@Param("id") profileId: string, @Param("channelId") channelId: string) {
    await this.db
      .delete(schema.profileChannel)
      .where(
        and(
          eq(schema.profileChannel.profileId, profileId),
          eq(schema.profileChannel.channelId, channelId),
        ),
      );
    return { ok: true };
  }

  @Get("channels")
  async listChannels() {
    const rows = await this.db
      .select({ ch: schema.channel, host: schema.host, link: schema.cascadeLink })
      .from(schema.channel)
      .leftJoin(schema.host, eq(schema.channel.hostId, schema.host.id))
      .leftJoin(schema.cascadeLink, eq(schema.channel.cascadeLinkId, schema.cascadeLink.id))
      .where(eq(schema.channel.orgId, this.cfg.defaultOrgId));

    return rows.map(({ ch, host, link }) => ({
      id: ch.id,
      kind: ch.kind,
      tag: ch.newTag ?? ch.tag,
      cc: ch.cc,
      hostId: ch.hostId,
      hostRemark: host?.remark ?? null,
      hostAddress: host?.address ?? null,
      hostDisabled: host?.isDisabled ?? null,
      cascadeLinkId: ch.cascadeLinkId,
      cascadeStatus: link?.status ?? null,
      // канал попадёт в подписку только если хост включён и каскад (если есть) готов
      servable: Boolean(host && !host.isDisabled && !host.isHidden && (!ch.cascadeLinkId || link?.status === "active")),
    }));
  }

  @Post("channels")
  async createChannel(
    @Body()
    body: {
      kind: "direct" | "cascade";
      tag: string;
      newTag?: string;
      cc?: string;
      hostId: string;
      cascadeLinkId?: string;
      frontNodeId?: string;
    },
  ) {
    const [row] = await this.db
      .insert(schema.channel)
      .values({
        orgId: this.cfg.defaultOrgId,
        kind: body.kind,
        tag: body.tag,
        newTag: body.newTag,
        cc: body.cc,
        hostId: body.hostId,
        cascadeLinkId: body.cascadeLinkId,
        frontNodeId: body.frontNodeId,
      })
      .returning();
    return row;
  }

  @Patch("channels/:id")
  async updateChannel(
    @Param("id") id: string,
    @Body() body: { tag?: string; newTag?: string; cc?: string; hostId?: string; cascadeLinkId?: string | null },
  ) {
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) if (v !== undefined) values[k] = v;

    const [row] = await this.db
      .update(schema.channel)
      .set(values)
      .where(and(eq(schema.channel.orgId, this.cfg.defaultOrgId), eq(schema.channel.id, id)))
      .returning();
    if (!row) throw new NotFoundException("канал не найден");
    return row;
  }

  @Delete("channels/:id")
  async deleteChannel(@Param("id") id: string) {
    await this.db.delete(schema.profileChannel).where(eq(schema.profileChannel.channelId, id));
    await this.db
      .delete(schema.channel)
      .where(and(eq(schema.channel.orgId, this.cfg.defaultOrgId), eq(schema.channel.id, id)));
    return { ok: true };
  }
}

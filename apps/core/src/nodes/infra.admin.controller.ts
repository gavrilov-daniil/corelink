import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { InfraService } from "./infra.service.js";
import { ProvisionService } from "./provision.service.js";
import type { Raw } from "./infra.validation.js";

/**
 * Заведение сети из админки: то, ради чего раньше был нужен INSERT в базу руками
 * (или seed.ts, который теперь остаётся только демо-данными для dev).
 *
 * Список нод отдаёт AdminController (`GET /api/admin/nodes`) — там же сходимость
 * desired/applied; здесь только запись, чтобы не заводить второй источник правды.
 */
@Controller("api/admin")
export class InfraAdminController {
  constructor(
    private readonly infra: InfraService,
    private readonly provisionSvc: ProvisionService,
  ) {}

  /**
   * Мастер «Добавить локацию»: одной транзакцией заводит сервер → профиль → ноду →
   * inbound → host и привязывает inbound к выбранным squad'ам. Идемпотентно по
   * натуральным ключам, поэтому повторный вызов ничего не дублирует.
   */
  @Post("infra/provision")
  provision(@Body() body: Raw) {
    return this.infra.provisionLocation(body ?? {});
  }

  /** Каскадное удаление локации: сервер + нода(ы) со всей цепочкой. Обратное provision. */
  @Delete("infra/locations/:serverId")
  deleteLocation(@Param("serverId") serverId: string) {
    return this.infra.deleteLocation(serverId);
  }

  // --- серверы ---

  @Get("servers")
  listServers() {
    return this.infra.listServers();
  }

  @Post("servers")
  createServer(@Body() body: Raw) {
    return this.infra.createServer(body ?? {});
  }

  @Patch("servers/:id")
  updateServer(@Param("id") id: string, @Body() body: Raw) {
    return this.infra.updateServer(id, body ?? {});
  }

  @Delete("servers/:id")
  deleteServer(@Param("id") id: string) {
    return this.infra.deleteServer(id);
  }

  @Post("servers/:id/ssh-check")
  sshCheck(@Param("id") id: string) {
    return this.infra.sshCheck(id);
  }

  // --- авто-настройка сервера по SSH (установка Xray + node-agent) ---

  @Post("servers/:id/provision")
  provisionServer(@Param("id") id: string) {
    return this.provisionSvc.start(id);
  }

  @Post("servers/:id/reprovision")
  reprovisionServer(@Param("id") id: string) {
    return this.provisionSvc.start(id, "reprovision");
  }

  @Get("servers/:id/provision-runs")
  listProvisionRuns(@Param("id") id: string) {
    return this.provisionSvc.listRuns(id);
  }

  @Get("provision-runs/:id")
  getProvisionRun(@Param("id") id: string) {
    return this.provisionSvc.getRun(id);
  }

  // --- config-профили ---

  @Get("config-profiles")
  listConfigProfiles() {
    return this.infra.listConfigProfiles();
  }

  @Post("config-profiles")
  createConfigProfile(@Body() body: Raw) {
    return this.infra.createConfigProfile(body ?? {});
  }

  @Patch("config-profiles/:id")
  updateConfigProfile(@Param("id") id: string, @Body() body: Raw) {
    return this.infra.updateConfigProfile(id, body ?? {});
  }

  @Delete("config-profiles/:id")
  deleteConfigProfile(@Param("id") id: string) {
    return this.infra.deleteConfigProfile(id);
  }

  // --- ноды ---

  @Post("nodes")
  createNode(@Body() body: Raw) {
    return this.infra.createNode(body ?? {});
  }

  @Patch("nodes/:id")
  updateNode(@Param("id") id: string, @Body() body: Raw) {
    return this.infra.updateNode(id, body ?? {});
  }

  @Delete("nodes/:id")
  deleteNode(@Param("id") id: string) {
    return this.infra.deleteNode(id);
  }

  // --- inbound'ы ---

  @Get("inbounds")
  listInbounds() {
    return this.infra.listInbounds();
  }

  @Post("inbounds")
  createInbound(@Body() body: Raw) {
    return this.infra.createInbound(body ?? {});
  }

  @Patch("inbounds/:id")
  updateInbound(@Param("id") id: string, @Body() body: Raw) {
    return this.infra.updateInbound(id, body ?? {});
  }

  @Delete("inbounds/:id")
  deleteInbound(@Param("id") id: string) {
    return this.infra.deleteInbound(id);
  }

  // --- host'ы ---

  @Get("hosts")
  listHosts() {
    return this.infra.listHosts();
  }

  @Post("hosts")
  createHost(@Body() body: Raw) {
    return this.infra.createHost(body ?? {});
  }

  @Patch("hosts/:id")
  updateHost(@Param("id") id: string, @Body() body: Raw) {
    return this.infra.updateHost(id, body ?? {});
  }

  @Delete("hosts/:id")
  deleteHost(@Param("id") id: string) {
    return this.infra.deleteHost(id);
  }

  // --- squad'ы ---

  @Get("squads")
  listSquads() {
    return this.infra.listSquads();
  }

  @Post("squads")
  createSquad(@Body() body: Raw) {
    return this.infra.createSquad(body ?? {});
  }

  @Patch("squads/:id")
  updateSquad(@Param("id") id: string, @Body() body: Raw) {
    return this.infra.updateSquad(id, body ?? {});
  }

  @Delete("squads/:id")
  deleteSquad(@Param("id") id: string) {
    return this.infra.deleteSquad(id);
  }
}

import { Body, Controller, Get, Headers, Param, Post } from "@nestjs/common";
import { NodeStateService } from "./node-state.service.js";
import { CascadeService } from "./cascade.service.js";
import { StatsService, type StatsBatch } from "./stats.service.js";
import { NodeIdentityService, type EnrollInput } from "./node-identity.service.js";
import { DesiredStateSigner } from "./desired-state.signer.js";

/**
 * API для node-agent. Агент ходит СЮДА сам (dial-out): ноде нужен только исходящий 443,
 * входящий control-порт на ноде не открывается, и панель не обязана знать её адрес.
 * Если панель лежит — агент продолжает крутить последний конфиг и копит статистику.
 *
 * Аутентификация — per-node токен в x-agent-token, выданный при энроллменте
 * (NodeIdentityService). Исключение — сам /enroll: его защищает одноразовый
 * bootstrap-токен в теле.
 */
@Controller("internal/agent")
export class AgentController {
  constructor(
    private readonly state: NodeStateService,
    private readonly cascades: CascadeService,
    private readonly stats: StatsService,
    private readonly identity: NodeIdentityService,
    private readonly signer: DesiredStateSigner,
  ) {}

  /** Обмен одноразового bootstrap-токена на постоянный per-node. Вызывается один раз за инкарнацию ноды. */
  @Post("enroll")
  enroll(@Body() body: EnrollInput) {
    return this.identity.enroll(body ?? {});
  }

  /** Полная декларация желаемого состояния. Агент сверяет config_hash и применяет только при отличии. */
  @Get("nodes/:nodeId/desired-state")
  async desiredState(@Param("nodeId") nodeId: string, @Headers("x-agent-token") token: string) {
    await this.identity.assertAgent(nodeId, token);
    const state = await this.state.getDesiredState(nodeId);
    return this.signer.wrap({
      version: state.version,
      configHash: state.configHash,
      config: state.config,
      users: state.users,
      generatedAt: state.generatedAt,
    });
  }

  @Post("nodes/:nodeId/report")
  async report(
    @Param("nodeId") nodeId: string,
    @Headers("x-agent-token") token: string,
    @Body()
    body: {
      appliedConfigHash?: string;
      agentVersion?: string;
      xrayVersion?: string;
      sysStats?: Record<string, unknown>;
      egressHealth?: Record<string, unknown>;
      xrayError?: string;
    },
  ) {
    await this.identity.assertAgent(nodeId, token);
    const result = await this.state.report(nodeId, body);

    // Статус каскада обязан быть непрерывной функцией от сходимости обеих нод, а не защёлкой
    // на deploy(): в момент deploy ноды заведомо ещё не забрали конфиг, и без пересчёта здесь
    // канал либо навсегда остаётся planned, либо навсегда active после отката ноды.
    // Композиция сделана в контроллере, а не внутри report(): NodeStateService↔CascadeService
    // дают ESM-кольцо, которое роняет процесс на старте (design:paramtypes читает класс из
    // ещё не инициализированного модуля). Отчёт агента приходит только сюда.
    await this.cascades.refreshForNode(nodeId);
    return result;
  }

  /** Приём батча статистики. Ответ с accepted=false означает «уже принято», агент дропает буфер. */
  @Post("nodes/:nodeId/stats")
  async ingestStats(
    @Param("nodeId") nodeId: string,
    @Headers("x-agent-token") token: string,
    @Body() body: StatsBatch,
  ) {
    await this.identity.assertAgent(nodeId, token);
    return this.stats.ingest(nodeId, body);
  }
}

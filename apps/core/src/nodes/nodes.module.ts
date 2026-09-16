import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller.js";
import { NodesAdminController } from "./nodes.admin.controller.js";
import { InfraAdminController } from "./infra.admin.controller.js";
import { InfraService } from "./infra.service.js";
import { NodeStateService } from "./node-state.service.js";
import { CascadeService } from "./cascade.service.js";
import { StatsService } from "./stats.service.js";
import { AbuseService } from "./abuse.service.js";
import { NodeIdentityService } from "./node-identity.service.js";
import { ProvisionService } from "./provision.service.js";
import { DesiredStateSigner } from "./desired-state.signer.js";

@Module({
  controllers: [AgentController, NodesAdminController, InfraAdminController],
  providers: [
    NodeStateService,
    CascadeService,
    StatsService,
    AbuseService,
    NodeIdentityService,
    ProvisionService,
    InfraService,
    DesiredStateSigner,
  ],
  exports: [
    NodeStateService,
    CascadeService,
    StatsService,
    AbuseService,
    NodeIdentityService,
    ProvisionService,
    InfraService,
  ],
})
export class NodesModule {}

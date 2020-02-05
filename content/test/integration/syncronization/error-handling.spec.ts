import ms from "ms"
import { buildEvent, assertEqualsDeployment, assertEntityWasNotDeployed, assertEntitiesAreActiveOnServer, assertHistoryOnServerHasEvents } from "../E2EAssertions"
import { Environment, EnvironmentConfig } from "@katalyst/content/Environment"
import { DAOClient } from "@katalyst/content/service/synchronization/clients/DAOClient"
import { Timestamp } from "@katalyst/content/service/time/TimeSorting"
import { ControllerEntityContent, ControllerEntity } from "@katalyst/content/controller/Controller"
import { MockedDAOClient } from "./clients/MockedDAOClient"
import { TestServer } from "../TestServer"
import { buildBaseEnv, sleep, buildDeployData, deleteServerStorage, createIdentity } from "../E2ETestUtils"
import { FailedDeployment, FailureReason } from "@katalyst/content/service/errors/FailedDeploymentsManager"
import { MockedAccessChecker } from "@katalyst/test-helpers/service/access/MockedAccessChecker"


describe("End 2 end - Error handling", () => {

    const DAO = MockedDAOClient.withAddresses('http://localhost:6060', 'http://localhost:7070')
    const identity = createIdentity()
    const SYNC_INTERVAL: number = ms("5s")
    let server1: TestServer, server2: TestServer
    let accessChecker = new MockedAccessChecker()

    let jasmine_default_timeout

    beforeAll(() => {
        jasmine_default_timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL
        jasmine.DEFAULT_TIMEOUT_INTERVAL = 100000
    })

    afterAll(() => {
        jasmine.DEFAULT_TIMEOUT_INTERVAL = jasmine_default_timeout
    })

    beforeEach(async () => {
        server1 = await buildServer("Server1_", 6060, SYNC_INTERVAL, DAO)
        server2 = await buildServer("Server2_", 7070, SYNC_INTERVAL, DAO)
    })

    afterEach(async function() {
        await server1.stop()
        await server2.stop()
        deleteServerStorage(server1, server2)
    })

    it(`When entity can't be retrieved, then the error is recorded and no entity is created`, async () => {
        await lala(FailureReason.NO_ENTITY_OR_AUDIT,
            entity => server1.blacklistEntity(entity, identity))
    });

    it(`When content can't be retrieved, then the error is recorded and no entity is created`, async () => {
        await lala(FailureReason.FETCH_PROBLEM,
            entity => server1.blacklistContent((entity.content as ControllerEntityContent[])[0].hash, identity))
    });

    it(`When an error happens during deployment, then the error is recorded and no entity is created`, async () => {
        await lala(FailureReason.DEPLOYMENT_ERROR,
            _ => { accessChecker.startReturningErrors(); return Promise.resolve() },
            () => { accessChecker.stopReturningErrors(); return Promise.resolve() })
    });

    async function lala(errorType: FailureReason, causeOfFailure: (entity: ControllerEntity) => Promise<void>, removeCauseOfFailure?: () => Promise<void>, ) {
        // Start servers
        await server1.start()
        await server2.start()

        // Prepare entity to deploy
        const [deployData, entityBeingDeployed] = await buildDeployData(["0,0", "0,1"], 'metadata', 'content/test/integration/resources/some-binary-file.png')

        // Deploy the entity
        const deploymentTimestamp: Timestamp = await server1.deploy(deployData)
        const deploymentEvent = buildEvent(entityBeingDeployed, server1, deploymentTimestamp)

        // Cause failure
        await causeOfFailure(entityBeingDeployed)

        // Wait for servers to sync
        await sleep(SYNC_INTERVAL * 2)

        // Assert deployment is marked as failed
        const failedDeployments: FailedDeployment[] = await server2.getFailedDeployments()
        expect(failedDeployments.length).toBe(1)
        assertEqualsDeployment(failedDeployments[0].deployment, deploymentEvent)
        expect(failedDeployments[0].reason).toEqual(errorType)
        expect(failedDeployments[0].moment).toBeGreaterThan(entityBeingDeployed.timestamp)

        // Assert entity wasn't deployed
        await assertEntityWasNotDeployed(server2, entityBeingDeployed)

        // Assert history was still modified
        await assertHistoryOnServerHasEvents(server2, deploymentEvent)

        // Assert immutable time is more recent than the entity
        const immutableTime = await server2.getStatus().then(status => status.lastImmutableTime)
        expect(immutableTime).toBeGreaterThan(0)

        // Remove cause of failure
        if (removeCauseOfFailure)
            await removeCauseOfFailure()

        // Fix the entity
        await server2.deploy(deployData, true)

        // Assert there are no more failed deployments
        const newFailedDeployments: FailedDeployment[] = await server2.getFailedDeployments()
        expect(newFailedDeployments.length).toBe(0)

        // Assert entity is there
        await assertEntitiesAreActiveOnServer(server2, entityBeingDeployed)
    }

    async function buildServer(namePrefix: string, port: number, syncInterval: number, daoClient: DAOClient) {
        const env: Environment = await buildBaseEnv(namePrefix, port, syncInterval, daoClient)
            .withConfig(EnvironmentConfig.DECENTRALAND_ADDRESS, identity.address)
            .withAccessChecker(accessChecker)
            .build()
        return new TestServer(env)
    }
})
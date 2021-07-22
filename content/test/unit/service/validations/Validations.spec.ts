import { ContentAuthenticator } from '@katalyst/content/service/auth/Authenticator'
import { Deployment } from '@katalyst/content/service/deployments/DeploymentManager'
import { NoFailure } from '@katalyst/content/service/errors/FailedDeploymentsManager'
import { Validations } from '@katalyst/content/service/validations/Validations'
import {
  DeploymentToValidate,
  ExternalCalls,
  ServerEnvironment,
  ValidationArgs
} from '@katalyst/content/service/validations/Validator'
import { MockedAccessChecker } from '@katalyst/test-helpers/service/access/MockedAccessChecker'
import { AuditInfo, Entity, EntityType, EntityVersion, Pointer, Timestamp } from 'dcl-catalyst-commons'
import * as EthCrypto from 'eth-crypto'
import ms from 'ms'

describe('Validations', function () {
  describe('Recent', () => {
    it(`When an entity with a timestamp too far into the past is deployed, then an error is returned`, async () => {
      const entity = buildEntity({ timestamp: Date.now() - ms('25m') })
      const args = buildArgs({ deployment: { entity } })

      const result = Validations.RECENT(args)

      await assertErrorsWere(result, 'The request is not recent enough, please submit it again with a new timestamp.')
    })

    it(`When an entity with a timestamp too far into the future is deployed, then an error is returned`, async () => {
      const entity = buildEntity({ timestamp: Date.now() + ms('20m') })
      const args = buildArgs({ deployment: { entity } })

      const result = Validations.RECENT(args)

      await assertErrorsWere(
        result,
        'The request is too far in the future, please submit it again with a new timestamp.'
      )
    })

    it(`When an entity with the correct timestamp is deployed, then no error is returned`, async () => {
      const entity = buildEntity({ timestamp: Date.now() })
      const args = buildArgs({ deployment: { entity } })

      const result = Validations.RECENT(args)

      await assertNoErrors(result)
    })
  })

  describe('Legacy entity', () => {
    const LEGACY_AUDIT_INFO = {
      version: EntityVersion.V3,
      deployedTimestamp: 10,
      authChain: [],
      migrationData: {
        // This is used for migrations
        originalVersion: EntityVersion.V2,
        data: 'data'
      }
    }

    const LEGACY_ENTITY = buildEntity({ timestamp: 1000 })

    it(`When a legacy entity is deployed and there is no entity, then no error is returned`, async () => {
      const args = buildArgs({ deployment: { entity: LEGACY_ENTITY, auditInfo: LEGACY_AUDIT_INFO } })

      const result = Validations.LEGACY_ENTITY(args)

      await assertNoErrors(result)
    })

    it(`When a legacy entity is deployed and there is an entity with a higher timestamp, then no error is returned`, async () => {
      const entity = buildEntity({ timestamp: 1001 })
      const auditInfo = {
        version: EntityVersion.V3,
        deployedTimestamp: 10,
        authChain: []
      }
      const args = buildArgs({
        deployment: { entity: LEGACY_ENTITY, auditInfo: LEGACY_AUDIT_INFO },
        externalCalls: { fetchDeployments: () => Promise.resolve(deploymentWith(entity, auditInfo)) }
      })

      const result = Validations.LEGACY_ENTITY(args)

      await assertNoErrors(result)
    })

    it(`When a legacy entity is deployed and there is a previous entity with a higher version, then an error is returned`, async () => {
      const entity = buildEntity({ timestamp: 999 })
      const legacyAuditInfo = { ...LEGACY_AUDIT_INFO, version: EntityVersion.V2 }
      const auditInfo = {
        version: EntityVersion.V3,
        authChain: []
      }
      const args = buildArgs({
        deployment: { entity: LEGACY_ENTITY, auditInfo: legacyAuditInfo },
        externalCalls: { fetchDeployments: () => Promise.resolve(deploymentWith(entity, auditInfo)) }
      })

      const result = Validations.LEGACY_ENTITY(args)

      await assertErrorsWere(result, `Found an overlapping entity with a higher version already deployed.`)
    })

    it(`When a legacy entity is deployed and there is a previous entity with a lower version, then no error is returned`, async () => {
      const entity = buildEntity({ timestamp: 999 })
      const auditInfo = {
        version: EntityVersion.V2,
        deployedTimestamp: 10,
        authChain: []
      }
      const args = buildArgs({
        deployment: { entity: LEGACY_ENTITY, auditInfo: LEGACY_AUDIT_INFO },
        externalCalls: { fetchDeployments: () => Promise.resolve(deploymentWith(entity, auditInfo)) }
      })

      const result = Validations.LEGACY_ENTITY(args)

      await assertNoErrors(result)
    })

    it(`When a legacy entity is deployed and there is a previous entity without original metadata, then an error is returned`, async () => {
      const entity = buildEntity({ timestamp: 999 })
      const auditInfo = {
        version: EntityVersion.V3,
        authChain: []
      }
      const args = buildArgs({
        deployment: { entity: LEGACY_ENTITY, auditInfo: LEGACY_AUDIT_INFO },
        externalCalls: { fetchDeployments: () => Promise.resolve(deploymentWith(entity, auditInfo)) }
      })

      const result = Validations.LEGACY_ENTITY(args)

      await assertErrorsWere(result, `Found an overlapping entity with a higher version already deployed.`)
    })

    it(`When a legacy entity is deployed and there is a previous entity with a higher original version, then an error is returned`, async () => {
      const entity = buildEntity({ timestamp: 999 })
      const auditInfo = {
        version: EntityVersion.V3,
        deployedTimestamp: 10,
        authChain: [],
        originalMetadata: {
          originalVersion: EntityVersion.V3,
          data: 'data'
        }
      }
      const args = buildArgs({
        deployment: { entity: LEGACY_ENTITY, auditInfo: LEGACY_AUDIT_INFO },
        externalCalls: { fetchDeployments: () => Promise.resolve(deploymentWith(entity, auditInfo)) }
      })

      const result = Validations.LEGACY_ENTITY(args)

      await assertErrorsWere(result, `Found an overlapping entity with a higher version already deployed.`)
    })

    it(`When a legacy entity is deployed and there is a previous entity with the same original version, then no error is returned`, async () => {
      const entity = buildEntity({ timestamp: 999 })
      const auditInfo = {
        version: EntityVersion.V3,
        deployedTimestamp: 10,
        authChain: [],
        migrationData: {
          originalVersion: EntityVersion.V2,
          data: 'data'
        }
      }
      const args = buildArgs({
        deployment: { entity: LEGACY_ENTITY, auditInfo: LEGACY_AUDIT_INFO },
        externalCalls: { fetchDeployments: () => Promise.resolve(deploymentWith(entity, auditInfo)) }
      })

      const result = Validations.LEGACY_ENTITY(args)

      await assertNoErrors(result)
    })
  })

  describe('Content', () => {
    it(`When a hash that was not uploaded and not present is referenced, it is reported`, async () => {
      const entity = buildEntity({
        content: new Map([['name', 'hash']])
      })
      const args = buildArgs({ deployment: { entity, files: new Map() } })

      const result = Validations.CONTENT(args)

      await assertErrorsWere(result, notAvailableHashMessage('hash'))
    })

    it(`When a hash that was not uploaded was already stored, then no error is returned`, async () => {
      const entity = buildEntity({
        content: new Map([['name', 'hash']])
      })
      const args = buildArgs({
        deployment: { entity, files: new Map() },
        externalCalls: { isContentStoredAlready: () => Promise.resolve(new Map([['hash', true]])) }
      })

      const result = Validations.CONTENT(args)

      await assertNoErrors(result)
    })

    it(`When a hash that was uploaded wasn't already stored, then no error is returned`, async () => {
      const entity = buildEntity({
        content: new Map([['name', 'hash']])
      })
      const args = buildArgs({
        deployment: { entity, files: new Map([['hash', Buffer.from([])]]) }
      })

      const result = Validations.CONTENT(args)

      await assertNoErrors(result)
    })

    it(`When a hash is uploaded but not referenced, it is reported`, async () => {
      const entity = buildEntity({ content: new Map([['name-1', 'hash-1']]) })
      const args = buildArgs({
        deployment: {
          entity,
          files: new Map([
            ['hash-1', Buffer.from([])],
            ['hash-2', Buffer.from([])]
          ])
        }
      })

      const result = Validations.CONTENT(args)

      await assertErrorsWere(result, notReferencedHashMessage('hash-2'))
    })

    const notAvailableHashMessage = (hash) => {
      return `This hash is referenced in the entity but was not uploaded or previously available: ${hash}`
    }

    const notReferencedHashMessage = (hash) => {
      return `This hash was uploaded but is not referenced in the entity: ${hash}`
    }
  })

  describe('Signature', () => {
    it(`When signature is invalid, it's reported`, async () => {
      const entity = buildEntity()
      const args = buildArgs({
        deployment: {
          entity,
          auditInfo: {
            version: EntityVersion.V3,
            authChain: ContentAuthenticator.createSimpleAuthChain(
              entity.id,
              '0x29d7d1dd5b6f9c864d9db560d72a247c178ae86b',
              'some-signature'
            )
          }
        }
      })

      const result = Validations.SIGNATURE(args)

      await assertSignatureInInvalid(result)
    })

    it(`when signature is valid, it's recognized`, async () => {
      const entity = buildEntity()
      const identity = EthCrypto.createIdentity()
      const authChain = ContentAuthenticator.createSimpleAuthChain(
        entity.id,
        identity.address,
        EthCrypto.sign(identity.privateKey, ContentAuthenticator.createEthereumMessageHash(entity.id))
      )
      const args = buildArgs({
        deployment: {
          entity,
          auditInfo: {
            version: EntityVersion.V3,
            authChain
          }
        }
      })

      const result = Validations.SIGNATURE(args)

      await assertNoErrors(result)
    })

    it(`when a valid chained signature is used, it's recognized`, async () => {
      const entity = buildEntity()
      const ownerIdentity = EthCrypto.createIdentity()
      const ephemeralIdentity = EthCrypto.createIdentity()
      const authChain = ContentAuthenticator.createAuthChain(ownerIdentity, ephemeralIdentity, 30, entity.id)
      const args = buildArgs({
        deployment: {
          entity,
          auditInfo: { version: EntityVersion.V3, authChain }
        }
      })

      const result = Validations.SIGNATURE(args)

      await assertNoErrors(result)
    })

    it(`when no signature is provided, it's reported`, async () => {
      const entity = buildEntity()
      const args = buildArgs({
        deployment: {
          entity,
          auditInfo: { version: EntityVersion.V3, authChain: [] }
        }
      })

      const result = Validations.SIGNATURE(args)

      await assertSignatureInInvalid(result)
    })
  })

  describe('Request size (v3)', () => {
    it(`when an entity is too big per pointer, then it fails`, async () => {
      const entity = buildEntity()
      const args = buildArgs({
        deployment: { entity, files: getFileWithSize(3) },
        env: { maxUploadSizePerTypeInMB: new Map([[EntityType.SCENE, 2]]) }
      })

      const result = Validations.REQUEST_SIZE_V3(args)

      const actualErrors = await result
      expect(actualErrors).toBeDefined()
      expect(actualErrors!.length).toBe(1)
      expect(actualErrors![0]).toMatch('The deployment is too big. The maximum allowed size per pointer is *')
    })

    it(`when an entity is big, but has enough pointers, then it is ok`, async () => {
      const entity = buildEntity({ pointers: ['P1', 'P2'] })
      const args = buildArgs({
        deployment: { entity, files: getFileWithSize(3) },
        env: { maxUploadSizePerTypeInMB: new Map([[EntityType.SCENE, 2]]) }
      })

      const result = Validations.REQUEST_SIZE_V3(args)

      await assertNoErrors(result)
    })
  })
})

function buildEntity(options?: { timestamp?: Timestamp; content?: Map<string, string>; pointers?: Pointer[] }) {
  const opts = Object.assign({ timestamp: Date.now(), content: undefined }, options)
  return {
    id: 'id',
    type: EntityType.SCENE,
    pointers: options?.pointers ?? ['P1'],
    timestamp: opts.timestamp,
    content: opts.content
  }
}

function getFileWithSize(sizeInMB: number) {
  return new Map([['someHash', Buffer.alloc(sizeInMB * 1024 * 1024)]])
}

async function assertSignatureInInvalid(result: undefined | string[] | Promise<undefined | string[]>) {
  const actualErrors = await result
  expect(actualErrors).toBeDefined()
  expect(actualErrors!.length).toBe(1)
  expect(actualErrors![0]).toMatch('The signature is invalid.*')
}

function deploymentWith(entity: Entity, auditInfo: Partial<AuditInfo>) {
  const deployment: Deployment = {
    ...entity,
    entityId: entity.id,
    entityTimestamp: entity.timestamp,
    entityType: entity.type,
    deployedBy: '0x...',
    content: undefined,
    auditInfo: {
      version: EntityVersion.V2,
      authChain: [],
      localTimestamp: 20,
      ...auditInfo
    }
  }
  return { deployments: [deployment] }
}

async function assertErrorsWere(
  result: undefined | string[] | Promise<undefined | string[]>,
  ...expectedErrors: string[]
) {
  const actualErrors = await result
  expect(actualErrors).toBeDefined()
  expect(actualErrors!).toEqual(expectedErrors)
}

async function assertNoErrors(
  result: undefined | string[] | Promise<undefined | string[]>,
  ...expectedErrors: string[]
) {
  const actualErrors = await result
  expect(actualErrors).toBeUndefined()
}

function buildArgs(args: {
  deployment: { entity: Entity } & Partial<DeploymentToValidate>
  env?: Partial<ServerEnvironment>
  externalCalls?: Partial<ExternalCalls>
}): ValidationArgs {
  return {
    deployment: {
      files: new Map(),
      auditInfo: {
        version: EntityVersion.V3,
        authChain: []
      },
      ...args.deployment
    },
    env: {
      accessChecker: new MockedAccessChecker(),
      authenticator: new ContentAuthenticator('ropsten'),
      requestTtlBackwards: ms('10m'),
      maxUploadSizePerTypeInMB: new Map(),
      ...args?.env
    },
    externalCalls: {
      fetchDeployments: (_) => Promise.resolve({ deployments: [] }),
      areThereNewerEntities: (_) => Promise.resolve(false),
      fetchDeploymentStatus: (_, __) => Promise.resolve(NoFailure.NOT_MARKED_AS_FAILED),
      isContentStoredAlready: (hashes) => Promise.resolve(new Map(hashes.map((hash) => [hash, false]))),
      isEntityDeployedAlready: (_) => Promise.resolve(false),
      ...args?.externalCalls
    }
  }
}

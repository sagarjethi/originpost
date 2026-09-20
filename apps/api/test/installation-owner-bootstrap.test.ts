import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../src/auth/auth.service.js';
import type { PasswordService } from '../src/auth/password.service.js';
import type { OriginPostInfrastructure } from '../src/infrastructure/infrastructure.types.js';

const installationOwner='user_00000000-0000-4000-8000-000000000001';
function fixture(existing?: {id:string;status:string}, role?: string) {
  const repository={
    findUserByEmail:vi.fn(async()=>existing?{...existing,email:'installer@example.test',passwordHash:'fixture-existing-hash'}:null),
    getMembership:vi.fn(async()=>role?{workspaceId:'default',userId:existing?.id,role}:null),
    createUserWithMembership:vi.fn(async()=>undefined),
  };
  const hash=vi.fn(async()=> 'fixture-hash');
  const config=new ConfigService({AUTH_MODE:'sessions',INSTALLATION_OWNER_ID:installationOwner,BOOTSTRAP_ADMIN_EMAIL:' Installer@Example.Test ',BOOTSTRAP_ADMIN_PASSWORD:'fixture-bootstrap-password',BOOTSTRAP_ADMIN_NAME:'Installation Owner'});
  const service=new AuthService({authRepository:repository} as unknown as OriginPostInfrastructure,{hash} as unknown as PasswordService,config);
  return {service,repository,hash};
}

describe('installation administrator bootstrap identity',()=>{
  it('creates the exact configured installation identity with an owner membership',async()=>{
    const {service,repository,hash}=fixture();await service.onModuleInit();
    expect(repository.findUserByEmail).toHaveBeenCalledWith('installer@example.test');
    expect(repository.createUserWithMembership).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      user:expect.objectContaining({id:installationOwner,email:'installer@example.test',displayName:'Installation Owner',passwordHash:'fixture-hash',status:'active'}),
      membership:expect.objectContaining({workspaceId:'default',userId:installationOwner,role:'owner'}),
      createdBy:installationOwner,
    }));
    expect(hash).toHaveBeenCalledWith('fixture-bootstrap-password');
  });
  it.each(['manager','creator','viewer',undefined])('rejects an existing account without owner membership (%s)',async role=>{
    const {service,repository}=fixture({id:installationOwner,status:'active'},role);
    await expect(service.onModuleInit()).rejects.toThrow('not an active owner');
    expect(repository.createUserWithMembership).not.toHaveBeenCalled();
  });
  it('rejects an active owner whose identity differs from the configured installer',async()=>{
    const {service,repository}=fixture({id:'user_00000000-0000-4000-8000-000000000002',status:'active'},'owner');
    await expect(service.onModuleInit()).rejects.toThrow('not an active owner');
    expect(repository.createUserWithMembership).not.toHaveBeenCalled();
  });
  it('rejects an inactive account even when its identity and role match',async()=>{
    const {service,repository}=fixture({id:installationOwner,status:'disabled'},'owner');
    await expect(service.onModuleInit()).rejects.toThrow('not an active owner');
    expect(repository.createUserWithMembership).not.toHaveBeenCalled();
  });
  it('accepts the existing matching active owner without resetting password or creating a user',async()=>{
    const {service,repository,hash}=fixture({id:installationOwner,status:'active'},'owner');
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(repository.getMembership).toHaveBeenCalledWith('default',installationOwner);
    expect(repository.createUserWithMembership).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalledWith('fixture-bootstrap-password');
  });
});

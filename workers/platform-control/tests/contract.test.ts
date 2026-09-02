import { describe, expect, it } from 'vitest';
import { normalizedEmail, validEvent } from '../src/contract';
const id='11111111-1111-4111-8111-111111111111';
describe('platform registry contract',()=>{
 it('accepts identifier-only versioned events',()=>expect(validEvent({event_id:id,entity_id:id,entity_type:'user',revision:1,operation:'upsert',payload:{email:'a@example.com'}})).toBe(true));
 it('rejects raw secret-shaped incomplete events',()=>expect(validEvent({event_id:id,entity_id:id,entity_type:'api_key',revision:0,operation:'upsert',payload:{raw_key:'secret'}})).toBe(false));
 it('normalizes email deterministically',()=>expect(normalizedEmail(' A@Example.COM ')).toBe('a@example.com'));
});

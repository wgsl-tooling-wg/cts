export const description = `
Execution tests for the 'cross' builtin function

T is AbstractFloat, f32, or f16
@const fn cross(e1: vec3<T> ,e2: vec3<T>) -> vec3<T>
Returns the cross product of e1 and e2.
`;

import { makeTestGroup } from '../../../../../../common/framework/test_group.js';
import { GPUTest } from '../../../../../gpu_test.js';
import { TypeF32, TypeVec } from '../../../../../util/conversion.js';
import { crossInterval } from '../../../../../util/f32_interval.js';
import { vectorTestValues } from '../../../../../util/math.js';
import { makeCaseCache } from '../../case_cache.js';
import {
  allInputSources,
  Case,
  makeVectorPairToVectorIntervalCase,
  run,
} from '../../expression.js';

import { builtin } from './builtin.js';

export const g = makeTestGroup(GPUTest);

export const d = makeCaseCache('cross', {
  f32: () => {
    const makeCase = (x: number[], y: number[]): Case => {
      return makeVectorPairToVectorIntervalCase(x, y, crossInterval);
    };

    return vectorTestValues(3, false).flatMap(i => {
      return vectorTestValues(3, false).map(j => {
        return makeCase(i, j);
      });
    });
  },
});

g.test('abstract_float')
  .specURL('https://www.w3.org/TR/WGSL/#float-builtin-functions')
  .desc(`abstract float tests`)
  .params(u => u.combine('inputSource', allInputSources))
  .unimplemented();

g.test('f32')
  .specURL('https://www.w3.org/TR/WGSL/#float-builtin-functions')
  .desc(`f32 tests`)
  .params(u => u.combine('inputSource', allInputSources))
  .fn(async t => {
    const cases = await d.get('f32');

    await run(
      t,
      builtin('cross'),
      [TypeVec(3, TypeF32), TypeVec(3, TypeF32)],
      TypeVec(3, TypeF32),
      t.params,
      cases
    );
  });

g.test('f16')
  .specURL('https://www.w3.org/TR/WGSL/#float-builtin-functions')
  .desc(`f16 tests`)
  .params(u => u.combine('inputSource', allInputSources))
  .unimplemented();

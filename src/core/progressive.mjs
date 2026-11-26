export function progressivePolicy(contract,settings) {
  if (contract.version!==2 || !contract.progressive) return null;
  const {minSamples,maxSamples=minSamples,requireConvergence=false} = contract.progressive;
  if (!contract.sample || !Number.isSafeInteger(minSamples) || minSamples<1 ||
      !Number.isSafeInteger(maxSamples) || maxSamples<minSamples ||
      typeof requireConvergence!=='boolean') throw new Error('Invalid progressive contract: declare minSamples, maxSamples and sample()');
  const budget = settings.sampleLimit ?? 512;
  if (minSamples>budget || (requireConvergence && maxSamples>budget))
    throw new Error('Artwork progressive sample requirements exceed the configured sample limit');
  return {minSamples,maxSamples:Math.min(maxSamples,budget),requireConvergence};
}

export async function accumulate(page,policy,args,check,report) {
  if (!policy) return null;
  let samples = 0;
  for (let step=0;step<policy.maxSamples;step++) {
    check();
    const state = await page.evaluate(async ({args,samples,limit})=>window.renderStudio.sample({...args,samples,sampleLimit:limit}),
      {args,samples,limit:policy.maxSamples});
    if (!Number.isSafeInteger(state?.samples) || state.samples<=samples || state.samples>policy.maxSamples)
      throw new Error('Progressive sample() must report a strictly increasing completed sample count within the budget');
    samples = state.samples;
    report(samples,policy.minSamples,policy.maxSamples);
    if (samples>=policy.minSamples && (!policy.requireConvergence || state.converged===true)) return samples;
  }
  throw new Error('Artwork did not reach its progressive convergence requirement');
}

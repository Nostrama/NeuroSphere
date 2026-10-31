(function(root) {
  'use strict';
  function targetFor(task,pattern) {
    if(!['OR','AND','XOR'].includes(task)||!['00','01','10','11'].includes(pattern))throw new Error('Invalid logic task or pattern.');
    const a=pattern[0]==='1',b=pattern[1]==='1';return task==='OR'?a||b:task==='AND'?a&&b:a!==b;
  }
  // External stimulus/reward apparatus. Neurons never receive truth-table data.
  class LogicTask {
    constructor(options,config) {
      if(!options||!['OR','AND','XOR'].includes(options.name))throw new Error('Invalid logic task.');
      this.config={name:options.name,patternSeed:options.patternSeed,period:options.period??2,responseWindow:options.responseWindow??.8};
      if(options.rewardScope!==undefined) {
        if(options.rewardScope!=='output-only')throw new Error('Invalid diagnostic reward scope.');
        this.config.rewardScope=options.rewardScope;
      }
      if(!Number.isInteger(this.config.patternSeed)||this.config.patternSeed<0||this.config.patternSeed>0xffffffff)throw new Error('Invalid task seed.');
      if(!Number.isFinite(this.config.period)||!Number.isFinite(this.config.responseWindow)||this.config.responseWindow<=0||this.config.responseWindow>=this.config.period)throw new Error('Invalid task timing.');
      if(!config.io||config.io.inputs.length!==2||config.io.outputs.length!==1||config.inputPeriod!==this.config.period)throw new Error('Logic task requires two inputs, one output and a matching period.');
      this.periodTicks=Math.round(this.config.period/config.dt);this.scoreTicks=Math.round(this.config.responseWindow/config.dt);
      if(Math.abs(this.periodTicks*config.dt-this.config.period)>1e-9||Math.abs(this.scoreTicks*config.dt-this.config.responseWindow)>1e-9)throw new Error('Task timing must align with integration ticks.');
      this.rngState=this.config.patternSeed;this.trials=[];this.current=null;
    }
    nextPattern() {this.rngState=(Math.imul(this.rngState,1664525)+1013904223)>>>0;return Math.floor(this.rngState/4294967296*4).toString(2).padStart(2,'0');}
    prepareTick(field) {
      const offset=(field.tick-1)%this.periodTicks;
      if(offset===0) {
        const index=Math.floor((field.tick-1)/this.periodTicks)+1,pattern=this.nextPattern();
        this.current={index,start:(index-1)*this.config.period,pattern,target:targetFor(this.config.name,pattern),
          inputSpikeIds:[],outputSpikeIds:[],lateOutputSpikeIds:[],scoredAt:null,response:null,correct:null,reward:0};
      }
      for(const [i,endpoint]of field.config.io.inputs.entries()) {
        const input=field.getNeuron(endpoint.id);if(!input)continue;
        // User-approved clamp of the externally controlled ports, not ordinary tissue.
        input.potential=input.restLevel;input.inbox=[];input.charges=[];input.lastTrigger=null;
        input.drivePeriod=this.config.period;
        input.nextDriveAt=offset===0&&this.current.pattern[i]==='1'?field.time:null;
      }
    }
    noteSpike(field,spike,output) {
      if(!this.current)return;
      if(field.config.io.inputs.some(i=>i.id===spike.neuronId))this.current.inputSpikeIds.push(spike.id);
      if(output) {
        const offset=(field.tick-1)%this.periodTicks+1;
        (offset<=this.scoreTicks?this.current.outputSpikeIds:this.current.lateOutputSpikeIds).push(spike.id);
      }
    }
    finishTick(field) {
      if((field.tick-1)%this.periodTicks+1!==this.scoreTicks)return 0;
      const trial=this.current;trial.scoredAt=field.time;trial.response=trial.outputSpikeIds.length>0;
      trial.correct=trial.response===trial.target;trial.reward=trial.correct?1:-1;this.trials.push(trial);return trial.reward;
    }
    measure() {
      const tail=this.trials.slice(-100),accuracy=tail.length?tail.filter(t=>t.correct).length/tail.length:null;
      return {taskName:this.config.name,taskTrials:this.trials.length,taskWindowTrials:tail.length,taskAccuracy:accuracy,taskFullWindowAccuracy:tail.length===100?accuracy:null};
    }
    toJSON() {return {config:{...this.config},rngState:this.rngState,trials:this.trials,current:this.current};}
    static fromJSON(saved,field) {
      const task=new LogicTask(saved.config,field.config);
      const expectedTrials=Math.floor((field.tick+task.periodTicks-task.scoreTicks)/task.periodTicks),currentIndex=field.tick?Math.floor((field.tick-1)/task.periodTicks)+1:0;
      if(!Array.isArray(saved.trials)||saved.trials.length!==expectedTrials||saved.trials.length>1000000||Boolean(saved.current)!==Boolean(currentIndex))throw new Error('Invalid task history length.');
      for(let index=1;index<=currentIndex;index++) {
        const pattern=task.nextPattern(),row=index<=saved.trials.length?saved.trials[index-1]:saved.current;
        if(!row||row.index!==index||row.start!==(index-1)*task.config.period||row.pattern!==pattern||row.target!==targetFor(task.config.name,pattern))throw new Error('Invalid task schedule.');
        if(!Array.isArray(row.inputSpikeIds)||!Array.isArray(row.outputSpikeIds)||!Array.isArray(row.lateOutputSpikeIds))throw new Error('Invalid task spike lists.');
        for(const id of [...row.inputSpikeIds,...row.outputSpikeIds,...row.lateOutputSpikeIds])if(!field.spikeRecords.has(id))throw new Error('Unknown task spike.');
        if(index<=expectedTrials&&(row.scoredAt!==((index-1)*task.periodTicks+task.scoreTicks)*field.config.dt||row.response!==(row.outputSpikeIds.length>0)||row.correct!==(row.response===row.target)||row.reward!==(row.correct?1:-1)))throw new Error('Invalid task score.');
      }
      if(task.rngState!==saved.rngState)throw new Error('Invalid task RNG state.');
      if(saved.current&&saved.current.index!==currentIndex)throw new Error('Invalid current trial.');
      if(saved.current&&currentIndex<=expectedTrials&&JSON.stringify(saved.current)!==JSON.stringify(saved.trials.at(-1)))throw new Error('Inconsistent current trial.');
      const pulse=field.tick&&((field.tick-1)%task.periodTicks+1===task.scoreTicks)?saved.trials.at(-1).reward:0;
      if(field.rewardPulse!==pulse)throw new Error('Invalid task reward pulse.');
      task.trials=saved.trials;task.current=currentIndex<=expectedTrials?task.trials.at(-1)??null:saved.current;return task;
    }
  }
  const api={LogicTask,targetFor};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.NeuronLogicTask=api;
})(typeof globalThis!=='undefined'?globalThis:this);

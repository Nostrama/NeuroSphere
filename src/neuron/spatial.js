(function(root) {
  'use strict';
  const {distance} = typeof module !== 'undefined' && module.exports ? require('./neuron.js') : root.NeuronCore;
  // Geometry only. Query results retain source-array order, so indexing cannot
  // change seeded growth draws, summation order or coincident-event ordering.
  class SpatialHash {
    constructor(items = [], cellSize = 195) {
      if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('Invalid spatial bin size.');
      this.cellSize = cellSize; this.items = []; this.positions = []; this.bins = new Map();
      this.update(items);
    }
    update(items) {
      if (items.length === this.items.length && items.every((p,i) => p === this.items[i] &&
          p.x === this.positions[i][0] && p.y === this.positions[i][1] && (p.z ?? 0) === this.positions[i][2])) return;
      this.items = [...items]; this.positions = items.map(p => [p.x,p.y,p.z ?? 0]); this.bins.clear();
      this.positions.forEach((p,i) => {
        const key = p.map(v => Math.floor(v / this.cellSize)).join('/');
        if (!this.bins.has(key)) this.bins.set(key, []);
        this.bins.get(key).push(i);
      });
    }
    indices(point, radius) {
      if (!Number.isFinite(radius) || radius < 0) throw new Error('Invalid query radius.');
      const p = [point.x, point.y, point.z ?? 0], lo = p.map(v => Math.floor((v-radius)/this.cellSize)),
        hi = p.map(v => Math.floor((v+radius)/this.cellSize)), found = [];
      for (let x=lo[0];x<=hi[0];x++) for (let y=lo[1];y<=hi[1];y++) for (let z=lo[2];z<=hi[2];z++) {
        const bin = this.bins.get(x+'/'+y+'/'+z);
        if (bin) for (const i of bin) if (distance(point,this.items[i]) <= radius) found.push(i);
      }
      return found.sort((a,b)=>a-b);
    }
    query(point,radius) { return this.indices(point,radius).map(i=>this.items[i]); }
  }
  const api={SpatialHash}; if(typeof module!=='undefined'&&module.exports)module.exports=api;root.NeuronSpatial=api;
})(typeof globalThis!=='undefined'?globalThis:this);

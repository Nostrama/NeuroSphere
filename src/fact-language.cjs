'use strict';
// A deliberately small grammar. It identifies query cues, never looks up answers.
const COLORS = new Set('red orange yellow green blue purple pink brown black white gray grey'.split(' '));
const RELATIONS = ['color', 'location', 'category'];
function normalized(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 200) throw new Error('Use 1–200 characters.');
  return text.normalize('NFKC').toLowerCase().trim().replace(/[.!?]+$/, '').trim().replace(/\s+/g, ' ');
}
function term(text) {
  const value = text.replace(/^(?:the|an|a) /, '');
  if (!/^[\p{L}\p{N}]+(?:[ '-][\p{L}\p{N}]+)*$/u.test(value) || value.split(' ').length > 3 || /\b(and|or|not|is|are)\b/.test(value)) return null;
  return value;
}
function color(text) {
  const value = text.replace(/^(?:light|dark) /, '');
  return COLORS.has(value) ? text.replace(/grey$/, 'gray') : null;
}
function location(preposition, place) { const name = term(place); return name ? preposition + ' the ' + name : null; }
function parseFact(text) {
  const value = normalized(text), match = /^(.+?) is (.+)$/.exec(value);
  if (!match) throw new Error('Use “The lamp is blue”, “The cup is on the table”, or “The robin is a bird”.');
  const subject = term(match[1]), predicate = match[2]; let relation, object;
  const place = /^(in|on|under|near) (.+)$/.exec(predicate);
  if (color(predicate)) { relation = 'color'; object = color(predicate); }
  else if (place) { relation = 'location'; object = location(place[1], place[2]); }
  else if (/^(a|an) /.test(predicate)) { relation = 'category'; object = term(predicate); }
  if (!subject || !object) throw new Error('That fact pattern is not supported. Use one color, location, or category per sentence.');
  return { subject, relation, object };
}
function parseQuestion(text) {
  const value = normalized(text); let match, cue, relation, direction = 'forward';
  if ((match = /^what colou?r is (.+)$/.exec(value))) { relation = 'color'; cue = term(match[1]); }
  else if ((match = /^where is (.+)$/.exec(value))) { relation = 'location'; cue = term(match[1]); }
  else if ((match = /^what (?:kind|type) of (?:object|thing|animal) is (.+)$/.exec(value))) { relation = 'category'; cue = term(match[1]); }
  else if ((match = /^which (?:objects?|things?|animals?) (?:is|are) (.+)$/.exec(value))) {
    direction = 'reverse'; const predicate = match[1], place = /^(in|on|under|near) (.+)$/.exec(predicate);
    if (color(predicate)) { relation = 'color'; cue = color(predicate); }
    else if (place) { relation = 'location'; cue = location(place[1], place[2]); }
    else if (/^(a|an) /.test(predicate)) { relation = 'category'; cue = term(predicate); }
  } else if ((match = /^what is (.+)$/.exec(value))) { relation = 'category'; cue = term(match[1]); }
  return cue && relation ? { supported: true, cue, relation, direction } : { supported: false };
}
function questions(fact) {
  const forward = fact.relation === 'color' ? 'What color is the ' + fact.subject + '?' : fact.relation === 'location' ? 'Where is the ' + fact.subject + '?' : 'What is the ' + fact.subject + '?';
  const reverse = 'Which object is ' + (fact.relation === 'category' ? 'a ' : '') + fact.object + '?';
  return { forward, reverse };
}
module.exports = { parseFact, parseQuestion, questions, RELATIONS };

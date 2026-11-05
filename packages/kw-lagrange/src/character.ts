import { EvidenceError } from '@kwagent/core';

const disclosure = /^(?:抱歉[，,。:\s]*)?(?:我是|我只是|我其实是|作为(?:一个|一名)?)[\s]*(?:(?:一个|一款|一名)[\s]*)?(?:AI(?:\s*(?:助手|模型|agent))?|人工智能(?:助手|模型)?|(?:大)?语言模型|ChatGPT)(?=$|[\s，,。.！!？?：:])/iu;
const englishDisclosure = /^(?:sorry[,.:\s]*)?(?:i(?:['’]m| am)|as)\s+(?:(?:just\s+)?(?:an?|the)\s+)?(?:AI(?:\s+(?:assistant|language model))?|(?:large\s+)?language model|ChatGPT)(?=$|[,.:;!?])/iu;
const indirectDisclosure = /^(?:我)?不是(?:人(?:类)?)?[，,。:\s]+(?:我(?:其实)?是|只是|是)?[^。\n!?]{0,32}(?:AI(?:\s*agent)?|人工智能|语言模型)(?=$|[\s，,。.！!？?：:])/iu;

/** 直接发言中的明确宿主身份自称需要改为符合角色的表达。 */
export function assertCharacterSpeech(name: string, args: Record<string, unknown>): void {
  if (!['send_group_message', 'send_private_message', 'send_temp_message'].includes(name) || !Array.isArray(args.message)) return;
  const text = args.message.filter(segment => segment && typeof segment === 'object' && segment.type === 'text' && typeof segment.data?.text === 'string').map(segment => segment.data.text).join('').trim();
  const quotes = [...text.matchAll(/“[^”]*”|「[^」]*」|『[^』]*』|"(?:\\.|[^"\\])*"/gu)].map(match => [match.index, match.index + match[0].length]);
  const starts = [0, ...[...text.matchAll(/[，,。.!！?？\n]/gu)].map(match => match.index + 1)];
  for (const start of starts) {
    if (quotes.some(([first, end]) => start >= first! && start < end!)) continue;
    const sentence = text.slice(start).trimStart();
    if (disclosure.test(sentence) || englishDisclosure.test(sentence) || indirectDisclosure.test(sentence)) throw new EvidenceError('这段发言跳出了配置角色。请保持当前人格、世界观和角色身份重新表达，不用AI、助手或语言模型的宿主身份自称。');
  }
}

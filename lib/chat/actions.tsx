import 'server-only'

import {
  createAI,
  createStreamableUI,
  getMutableAIState,
  getAIState,
  streamUI,
  createStreamableValue,

} from 'ai/rsc'
import { openai } from '@ai-sdk/openai'

import {
  spinner,
  BotCard,
  BotMessage,
  SystemMessage,
} from '@/components/example'

import { string, z } from 'zod'
import { AddRfpSkeleton } from '@/components/rfp/add-rfp-skeleton'
import {
  formatNumber,
  runAsyncFnWithoutBlocking,
  sleep,
  nanoid
} from '@/lib/utils'
import { saveChat } from '@/app/actions'
import { SpinnerMessage, UserMessage } from '@/components/example/message'
import { Chat, Message } from '@/lib/types'
import { auth } from '@/auth'
import { AddRFP } from '@/components/rfp/add-rfp'

async function confirmPurchase(symbol: string, price: number, amount: number) {
  'use server'

  const aiState = getMutableAIState<typeof AI>()

  const purchasing = createStreamableUI(
    <div className="inline-flex items-start gap-1 md:items-center">
      {spinner}
      <p className="mb-2">
        Purchasing {amount} ${symbol}...
      </p>
    </div>
  )

  const systemMessage = createStreamableUI(null)

  runAsyncFnWithoutBlocking(async () => {
    await sleep(1000)

    purchasing.update(
      <div className="inline-flex items-start gap-1 md:items-center">
        {spinner}
        <p className="mb-2">
          Purchasing {amount} ${symbol}... working on it...
        </p>
      </div>
    )

    await sleep(1000)

    purchasing.done(
      <div>
        <p className="mb-2">
          You have successfully purchased {amount} ${symbol}. Total cost:{' '}
          {formatNumber(amount * price)}
        </p>
      </div>
    )

    systemMessage.done(
      <SystemMessage>
        You have purchased {amount} shares of {symbol} at ${price}. Total cost ={' '}
        {formatNumber(amount * price)}.
      </SystemMessage>
    )

    aiState.done({
      ...aiState.get(),
      messages: [
        ...aiState.get().messages,
        {
          id: nanoid(),
          role: 'system',
          content: `[User has purchased ${amount} shares of ${symbol} at ${price}. Total cost = ${amount * price
            }]`
        }
      ]
    })
  })

  return {
    purchasingUI: purchasing.value,
    newMessage: {
      id: nanoid(),
      display: systemMessage.value
    }
  }
}

async function submitUserMessage(content: string) {
  'use server'

  const aiState = getMutableAIState<typeof AI>()

  aiState.update({
    ...aiState.get(),
    messages: [
      ...aiState.get().messages,
      {
        id: nanoid(),
        role: 'user',
        content
      }
    ]
  })

  let textStream: undefined | ReturnType<typeof createStreamableValue<string>>
  let textNode: undefined | React.ReactNode

  const res = await fetch('https://prompt-agent-smartcontract-tool.vercel.app/api/tools?user_id=kurodenjiro');
  const dataTools = await res.json()
  const zodExtract = (type: any, describe: any) => {
    if (type == 'u128') return z.number().describe(describe)
    if (type == 'u64') return z.number().describe(describe)
    if (type == 'u8') return z.number().describe(describe)
    if (type == 'bool') return z.boolean().describe(describe)
    if (type == 'address') return z.string().describe(describe)
    if (type == 'vector<u8>') return z.string().describe(describe)
    if (type == 'vector<address>') return z.array(z.string()).describe(describe)
    if (type == 'vector<string::String>') return z.array(z.string()).describe(describe)
    return z.string().describe(describe)
  }

  const tools = dataTools.reduce((tool: any, item: any) => {

    const ParametersSchema = Object.keys(item.tool.params).reduce((acc: any, key: any) => {
      acc[key] = key = zodExtract(item.tool.params[key].type, item.tool.params[key].description);
      return acc;
    }, {})
    type ParametersData = z.infer<typeof ParametersSchema>;
    tool[item.name.replaceAll(':', "")] = {
      description: item.tool.description,
      parameters: z.object(ParametersSchema),
      generate: async function* (ParametersData: ParametersData) {
        yield (
          <BotCard>
            <AddRfpSkeleton />
          </BotCard>
        )

        await sleep(1000)

        const toolCallId = nanoid()
        aiState.done({
          ...aiState.get(),
          messages: [
            ...aiState.get().messages,
            {
              id: nanoid(),
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolName: item.name.replaceAll(':', ""),
                  toolCallId,
                  args: ParametersData
                }
              ]
            },
            {
              id: nanoid(),
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolName: item.name.replaceAll(':', ""),
                  toolCallId,
                  result: ParametersData
                }
              ]
            }
          ]
        })

        return (
          <BotCard>
            <BotCard>
              <AddRFP props={ParametersData} />
            </BotCard>
          </BotCard>
        )
      }
    };
    return tool;
  }, {});

  const result = await streamUI({
    model: openai('gpt-3.5-turbo'),
    initial: <SpinnerMessage />,
    system: ` You are helpful assasint . do what user say`,
    messages: [
      ...aiState.get().messages.map((message: any) => ({
        role: message.role,
        content: message.content,
        name: message.name
      }))
    ],
    text: ({ content, done, delta }) => {
      if (!textStream) {
        textStream = createStreamableValue('')
        textNode = <BotMessage content={textStream.value} />
      }

      if (done) {
        textStream.done()
        aiState.done({
          ...aiState.get(),
          messages: [
            ...aiState.get().messages,
            {
              id: nanoid(),
              role: 'assistant',
              content
            }
          ]
        })
      } else {
        textStream.update(delta)
      }

      return textNode
    },
    tools: tools
  })

  return {
    id: nanoid(),
    display: result.value
  }
}

export type AIState = {
  chatId: string
  messages: Message[]
}

export type UIState = {
  id: string
  display: React.ReactNode
}[]

export const AI = createAI<AIState, UIState>({
  actions: {
    submitUserMessage,
    confirmPurchase
  },
  initialUIState: [],
  initialAIState: { chatId: nanoid(), messages: [] },
  onGetUIState: async () => {
    'use server'

    const session = await auth()

    if (session && session.user) {
      const aiState = getAIState() as Chat

      if (aiState) {
        const uiState = getUIStateFromAIState(aiState)
        return uiState
      }
    } else {
      return
    }
  },
  onSetAIState: async ({ state }) => {
    'use server'

    const session = await auth()

    if (session && session.user) {
      const { chatId, messages } = state

      const createdAt = new Date()
      const userId = session.user.id as string
      const path = `/chat/${chatId}`

      const firstMessageContent = messages[0].content as string
      const title = firstMessageContent.substring(0, 100)

      const chat: Chat = {
        id: chatId,
        title,
        userId,
        createdAt,
        messages,
        path
      }

      await saveChat(chat)
    } else {
      return
    }
  }
})

export const getUIStateFromAIState = (aiState: Chat) => {
  return aiState.messages
    .filter(message => message.role !== 'system')
    .map((message, index) => ({
      id: `${aiState.chatId}-${index}`,
      display:
        message.role === 'tool' ? (
          message.content.map(tool => {
            return tool.toolName === 'addRFP' ? (
              <BotCard>
                {/* TODO: Infer types based on the tool result*/}
                <AddRFP props={tool.result} />
              </BotCard>
            ) : null
          })
        ) : message.role === 'user' ? (
          <UserMessage>{message.content as string}</UserMessage>
        ) : message.role === 'assistant' &&
          typeof message.content === 'string' ? (
          <BotMessage content={message.content} />
        ) : null
    }))
}

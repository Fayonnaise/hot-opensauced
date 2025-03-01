import { MdOutlineSubdirectoryArrowRight } from "react-icons/md";
import { Fragment, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { TrashIcon } from "@heroicons/react/24/outline";
import { BsArrowUpShort } from "react-icons/bs";
import { ThumbsdownIcon, ThumbsupIcon, XCircleIcon } from "@primer/octicons-react";
import clsx from "clsx";
import { captureException } from "@sentry/nextjs";
import { useRouter } from "next/router";
import { BiConversation } from "react-icons/bi";
import { Drawer } from "components/shared/Drawer";
import {
  StarSearchFeedbackAnalytic,
  StarSearchPromptAnalytic,
  useStarSearchFeedback,
} from "lib/hooks/useStarSearchFeedback";
import { useToast } from "lib/hooks/useToast";
import { StarSearchLoader } from "components/StarSearch/StarSearchLoader";
import StarSearchLoginModal from "components/StarSearch/LoginModal";
import { writeToClipboard } from "lib/utils/write-to-clipboard";
import { useGetStarSearchThreadHistory } from "lib/hooks/api/useGetStarSearchThreadHistory";
import { deleteWorkspaceStarSearchThread, getThreadStream } from "lib/utils/star-search-utils";
import { UuidSchema, parseSchema } from "lib/validation-schemas";
import Button from "components/shared/Button/button";
import {
  StarSearchHistoryItem,
  useGetStarSearchWorkspaceHistory,
} from "lib/hooks/api/useGetStarSearchWorkspaceHistory";
import { ChatAvatar } from "./ChatAvatar";
import { WidgetDefinition } from "./StarSearchWidget";
import { Chatbox, StarSearchChatMessage } from "./Chatbox";
import { SuggestedPrompts } from "./SuggestedPrompts";
import { ShareChatMenu } from "./ShareChatMenu";
import { StarSearchCompactHeader } from "./StarSearchCompactHeader";
import "@github/relative-time-element";

const DEFAULT_STAR_SEARCH_API_BASE_URL = new URL(`${process.env.NEXT_PUBLIC_API_URL!}/star-search`);
const cannedMessage = `I am a chat bot that highlights open source contributors. Try asking about a contributor you know in the open source ecosystem or a GitHub project you use!

Need some ideas? Try hitting the **Need Inspiration?** button below!`;

const componentRegistry = new Map<string, React.ComponentType<any>>();

async function updateComponentRegistry(name: string) {
  if (componentRegistry.has(name)) {
    return;
  }

  try {
    let component;

    switch (name) {
      case "renderLottoFactor":
        component = (await import("components/StarSearch/Widgets/LotteryFactorWidget")).default;
        break;
      default:
        break;
    }

    if (component) {
      componentRegistry.set(name, component);
    }
  } catch (error) {
    captureException(
      new Error(`Unable to dynamically import the widget component for StarSearch. Widget name: ${name}`, {
        cause: error,
      })
    );
  }
}

interface StarSearchHistoryProps {
  history: StarSearchHistoryItem[];
  onLoadThread: (conversationId: string) => void;
  onNewChat: () => void;
  onDeleteThread?: (conversationId: string) => void;
  loadMore?: () => void;
}

const StarSearchHistory = ({ history, onNewChat, onLoadThread, onDeleteThread, loadMore }: StarSearchHistoryProps) => {
  return (
    <div className="flex flex-col gap-2 w-full px-2">
      <h2 className="fixed text-slate-800 font-semibold w-full bg-light-slate-2 pt-2">StarSearch History</h2>
      {history.length === 0 ? (
        <div className="flex flex-col items-center gap-4 pt-10 ">
          <p>No previous conversations with StarSearch. Start a new conversation</p>
          <Button variant="primary" onClick={() => onNewChat()} className="flex gap-2 items-center">
            <BiConversation size={18} />
            <span>Start a new conversation</span>
          </Button>
        </div>
      ) : (
        <div className="pb-20">
          <ul className="grid gap-2 pt-10 [&_li]:p-2" aria-label="StarSearch History">
            {history.map((item) => (
              <li
                key={item.id}
                className="flex justify-between items-center w-full gap-2 [&:focus-within_[data-delete]]:border-1 [&:focus-within_[data-delete]]:text-inherit focus-within:bg-light-slate-3 hover:bg-light-slate-3 rounded-md hover:text-orange-700 [&_[data-delete]]:hover:text-orange-700"
              >
                <div className="grid">
                  <button
                    onClick={(event) => {
                      const { starSearchThreadId } = event.currentTarget.dataset;
                      starSearchThreadId && onLoadThread(starSearchThreadId);
                    }}
                    className="p-2 text-left rounded-md"
                    data-star-search-thread-id={item.id}
                  >
                    {item.title}
                  </button>
                  <div className="px-2 text-sm text-light-slate-10">
                    <relative-time datetime={item.updated_at ?? item.created_at} />
                  </div>
                </div>
                <div className="grid place-content-center">
                  <button
                    data-delete
                    data-id={item.id}
                    className="p-2 rounded-md text-light-slate-8"
                    onClick={(event) => {
                      const { starSearchThreadId } = event.currentTarget.dataset;
                      starSearchThreadId && onDeleteThread?.(starSearchThreadId);
                    }}
                    data-star-search-thread-id={item.id}
                  >
                    <span className="sr-only">Delete conversation</span>
                    <TrashIcon width={18} height={18} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {loadMore ? (
            <div className="grid place-content-center">
              <Button variant="default" onClick={loadMore} className="flex gap-2 items-center justify-center w-fit">
                Load more...
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};

type StarSearchChatProps = {
  userId?: number | null;
  sharedPrompt?: string | null;
  sharedChatId?: string | null;
  bearerToken: string | undefined | null;
  isMobile: boolean;
  showTopNavigation?: boolean;
  suggestions: { title: string; prompt: string }[];
  tagline?: string;
  embedded?: boolean;
  onClose?: () => void;
  baseApiStarSearchUrl?: URL;
  sharingEnabled?: boolean;
  workspaceId?: string;
};

type StarSearchState = "initial" | "chat" | "history";

export function StarSearchChat({
  userId,
  sharedChatId = null,
  sharedPrompt = null,
  bearerToken,
  isMobile,
  suggestions,
  tagline = "Copilot, but for git history",
  onClose,
  embedded = false,
  baseApiStarSearchUrl = DEFAULT_STAR_SEARCH_API_BASE_URL,
  sharingEnabled = true,
  showTopNavigation = false,
  workspaceId,
}: StarSearchChatProps) {
  const [starSearchState, setStarSearchState] = useState<StarSearchState>("initial");
  const [chat, setChat] = useState<StarSearchChatMessage[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [ranOnce, setRanOnce] = useState(false);
  const { feedback, prompt } = useStarSearchFeedback(!!workspaceId);
  const { toast } = useToast();
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [checkAuth, setCheckAuth] = useState(false);
  const [chatId, setChatId] = useState<string | null>(sharedChatId);
  const [shareLinkError, setShareLinkError] = useState(false);
  const streamRef = useRef<ReadableStreamDefaultReader<string>>();

  useEffect(() => {
    if (!workspaceId) {
      return;
    }

    onNewChat();
  }, [workspaceId]);

  const {
    data: starSearchHistory,
    isError: isHistoryError,
    isLoading: isLoadingHistory,
    mutate: mutateStarSearchHistory,
    loadMore,
  } = useGetStarSearchWorkspaceHistory({ workspaceId });

  const onNewChat = () => {
    streamRef.current?.cancel();
    setIsRunning(false);
    setChatId(null);
    setStarSearchState("initial");
    setChat([]);
  };

  const {
    data: threadHistory,
    isError,
    isLoading,
    mutate: mutateThreadHistory,
  } = useGetStarSearchThreadHistory(chatId, workspaceId);
  const router = useRouter();

  function clearChatHistory() {
    if (sharedChatId) {
      router.push("/star-search");
    }

    onNewChat();
  }

  async function deleteStarSearchThread(threadId: string) {
    if (!bearerToken) {
      setLoginModalOpen(true);
      return;
    }

    const { error } = await deleteWorkspaceStarSearchThread({
      workspaceId,
      threadId,
      bearerToken,
    });

    if (error) {
      toast({ description: "Failed to delete conversation", variant: "danger" });
      return;
    }

    mutateStarSearchHistory();

    toast({ description: "Conversation deleted", variant: "success" });
  }

  useEffect(() => {
    // This is for legacy shared prompts. See https://github.com/open-sauced/app/pull/3324
    if (!sharedPrompt || ranOnce) {
      return;
    }

    if (bearerToken) {
      setLoginModalOpen(false);
    } else {
      setLoginModalOpen(true);
      return;
    }

    if (inputRef.current) {
      addPromptInput(sharedPrompt);
    }
  }, [sharedPrompt, inputRef.current, bearerToken, ranOnce]);

  useEffect(() => {
    // Prevents the thread history from running when a new thread has been created and is currently
    // being used. This check is also to prevent the thread history from running multiple times.
    if (isRunning || !threadHistory || isLoading || (!threadHistory && (!sharedChatId || (ranOnce && sharedChatId)))) {
      return;
    }

    if (isError) {
      chatError();
      return;
    }

    // Reset chat as we're loading a shared chat
    setChat([]);

    const stream = getThreadStream(threadHistory.thread_history);
    setStarSearchState("chat");
    streamRef.current = stream.getReader();
    processStream(streamRef.current);
  }, [threadHistory, isError, isLoading, sharedChatId]);

  function chatError(resetChatId = false) {
    setStarSearchState("chat");
    setChat((history) => {
      const temp = [...history];

      temp.push({ author: "StarSearch", content: cannedMessage });
      return temp;
    });
    setIsRunning(false); // enables input
    setCheckAuth(true);
    if (resetChatId) {
      setChatId(null);
    }
  }

  async function processStream(reader: ReadableStreamDefaultReader<string> | undefined) {
    if (!reader) {
      chatError();
      return;
    }

    while (true) {
      const { done, value } = await reader!.read();
      if (done) {
        setIsRunning(false); // enables input
        setCheckAuth(true);

        // Since this is a new conversation, have the StarSearch history update.
        mutateStarSearchHistory();
        setChat((chat) => {
          // This is a bit of a hack.
          //
          // We're not changing the chat state, but we're using this as a way to capture the user prompt and the
          // StarSearch response as an analytic.
          const [userPrompt, ...systemResponses] = chat;

          if (!userPrompt) {
            // the streamed response was cancelled by the user as they
            // started a new conversation.
            return chat;
          }

          registerPrompt({
            // userPrompt.content will always be a string, but the .toString() is we don't need to check
            // the type of StarSearch message
            promptContent: userPrompt.content.toString(),
            promptResponse:
              systemResponses
                // There can be multiple responses because of widgets, so we need to serialize the widget data
                .map((c) => (typeof c.content === "string" ? c.content : JSON.stringify(c.content)))
                .join("\n") || "No response captured",
          });

          return chat;
        });
        return;
      }

      /**
        Content has this shape where each chunk has the concatenated "content.parts"
        that make up the whole message as it flows in.

        id: 1
        data: {"id":"123-abc","author":"manager","iso_time":"2024-05-20T20:30:42.0","content":{"type":"content","parts":["I"]},"status":"in_progress","error":null}

        id: 2
        data: {"id":"123-abc","author":"manager","iso_time":"2024-05-20T20:30:43.0","content":{"type":"content","parts":["I am"]},"status":"in_progress","error":null}

        id: 3
        data: {"id":"123-abc","author":"manager","iso_time":"2024-05-20T20:30:44.0","content":{"type":"content","parts":["I am StarSearch"]},"status":"in_progress","error":null}

        ... etc. etc.

        id: 5
        data: {"id":"123-abc","author":"manager","iso_time":"2024-05-20T20:30:45.0","content":{"type":"content","parts":["I am StarSearch. Witness me."]},"status":"done","error":null}


        If the content.type is "function_call", we know we need to render a component.
        if the content.type is "content", we render the markdown as HTML.
       */

      const values = value?.split("\n") || [];

      values.forEach(async (v) => {
        if (v.startsWith("id:")) {
          // this is just the id of the SSE from the response.
          return;
        }

        if (v.startsWith("data:")) {
          /*
           * regex for capturing star-search stream events JSON:
           * data:\s(?<result>.*)
           *
           * The aim of this regex is to capture all characters coming from
           * the star-search server side events.
           *
           * 'data:' - matches the "data:" characters explicitly.
           * '\s'    - matches any whitespace that follows the data. In most cases, this is a single space ' '.
           *           So, for example, this captures 'data: '.
           *
           * '(?<result>.*)' - named capture group "result".
           *    ├────── '?<result>'  - capture group is named "result".
           *    └────── '.*'         - matches any characters (including zero characters) after the "data:\s" segment.
           *                           Should capture ALL of the json object on the line after 'data: '.
           *
           * Example: data: { id: "abc123" }
           * - Captures the 'data: ' (including the space)
           * - The named capture group "result" gets the entire JSON object "{ id: \"abc123\" }"
           *   as a string that can be parsed to an object.
           */

          const matched = v.match(/data:\s(?<result>.*)/);

          if (!matched || !matched.groups) {
            return;
          }

          try {
            let jsonContent: WidgetDefinition;
            const { result } = matched.groups;

            // deserialize the json dump from the payload
            let payload = JSON.parse(result) as StarSearchPayload;

            // begin: temporary until John updates message column
            if ("data" in payload) {
              payload = payload.data as StarSearchPayload;
            }
            // end: temporary until John updates message column

            // skip over cases where the payload is somehow malformed or missing content altogether
            if (!payload || !payload.content || payload.content.parts.length === 0) {
              captureException(new Error(`Parsed and rejected malformed JSON for StarSearch. JSON payload: ${v}`));
              return;
            }

            // function_call means we're loading a widget definition for the enriched UI
            if (payload.content.type === "function_call") {
              jsonContent = JSON.parse(payload.content.parts[0]);
              jsonContent.arguments = JSON.parse(jsonContent.arguments as any) as WidgetDefinition["arguments"];
              await updateComponentRegistry(jsonContent.name);

              setChat((chat) => {
                const updatedChat = [...chat];

                // create a new chat item because the widget will require it's own chatbox.
                updatedChat.push({
                  author: "StarSearch",
                  content: jsonContent,
                });

                return updatedChat;
              });
            }

            if (payload.content.type === "content" || payload.content.type === "final") {
              setChat((chat) => {
                const updatedChat = [...chat];

                if (updatedChat.length <= 1) {
                  updatedChat.push({
                    author: "StarSearch",
                    content: payload.content.parts[0],
                  });

                  return updatedChat;
                }

                let changes = updatedChat.at(-1);

                if (changes) {
                  if (!changes || typeof changes.content !== "string") {
                    // if the previous item in the chats was a widget, we need to add a new chat item.
                    updatedChat.push({
                      author: "StarSearch",
                      content: "",
                    });
                    changes = updatedChat.at(-1);
                  }

                  if (changes) {
                    // set the content that was reserved by the stream event
                    changes.content = payload.content.parts[0];
                  }
                }

                return updatedChat;
              });
            }

            if (payload.content.type === "user_prompt") {
              setChat((chat) => {
                const updatedChat = [...chat];

                updatedChat.push({
                  // If this is a shared conversation, the author is StarSearch, otherwise it's the user
                  author: sharedChatId ? "StarSearch" : "You",
                  content: payload.content.parts[0],
                });

                return updatedChat;
              });
            }
          } catch (error) {
            captureException(new Error(`Failed to parse JSON for StarSearch. JSON payload: ${v}`, { cause: error }));
          }

          return;
        }
      });
    }
  }

  function registerPrompt(promptInput: StarSearchPromptAnalytic) {
    prompt({
      promptContent: promptInput.promptContent,
      promptResponse: promptInput.promptResponse,
    });
  }

  function registerFeedback(feedbackType: StarSearchFeedbackAnalytic["feedback"]) {
    feedback({
      feedback: feedbackType,
      promptContent: chat
        .filter(({ author }) => author === "You")
        .map(({ content }) => {
          if (typeof content !== "string") {
            return JSON.stringify(content);
          }

          return content;
        }),
      promptResponse: chat
        .filter(({ author }) => author === "StarSearch")
        .map(({ content }) => {
          if (typeof content !== "string") {
            return JSON.stringify(content);
          }

          return content;
        }),
    });
    toast({ description: "Thank you for your feedback!", variant: "success" });
  }

  function addPromptInput(prompt: string) {
    if (!inputRef.current?.form) {
      return;
    }

    inputRef.current.value = prompt;
    const { form } = inputRef.current;

    setTimeout(() => {
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    });
  }

  const submitPrompt = async (prompt: string) => {
    if ((checkAuth && sharedChatId && !bearerToken) || (!bearerToken && !sharedChatId)) {
      setLoginModalOpen(true);
      return;
    }

    if (isRunning) {
      return;
    }

    if (!ranOnce) {
      setRanOnce(true);
    }

    if (starSearchState === "initial") {
      setStarSearchState("chat");
    }
    setIsRunning(true); // disables input

    // add user prompt to history
    setChat((history) => {
      const temp = [...history];
      temp.push({ author: "You", content: prompt });
      return temp;
    });

    // Get new StarSearch conversation ID
    let id = chatId;

    if (!id) {
      const starSearchThreadResponse = await fetch(baseApiStarSearchUrl, {
        method: "POST",
        body: "{}",
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
        },
      });

      if (starSearchThreadResponse.status !== 201) {
        chatError(true);
        return;
      }

      const payload = await starSearchThreadResponse.json();
      id = payload.id;

      try {
        parseSchema(UuidSchema, id);
      } catch (error) {
        captureException(new Error(`Failed to parse UUID for StarSearch. UUID: ${chatId}`, { cause: error }));
        chatError(true);
        return;
      }

      const updateStarSearchThreadTitle = await fetch(`${baseApiStarSearchUrl}/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: prompt }),
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
        },
      });

      if (updateStarSearchThreadTitle.status !== 200) {
        captureException(new Error(`Failed to update StarSearch thread title. UUID: ${id}`));
      }

      setChatId(id);
    }

    const response = await fetch(`${baseApiStarSearchUrl}/${id}/stream`, {
      method: "POST",
      body: JSON.stringify({
        query_text: prompt,
      }),
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
    });

    // This updates the StarSearch history with the new conversation
    // This gets called when the stream completes as well, but we want to update
    // the StarSearch history here as well in case they cancel the conversation.
    mutateStarSearchHistory();

    if (response.status !== 200) {
      chatError();
      return;
    }

    const decoder = new TextDecoderStream();
    streamRef.current = response.body?.pipeThrough(decoder).getReader();
    processStream(streamRef.current);
  };

  const renderState = () => {
    switch (starSearchState) {
      case "initial":
        return (
          <div
            style={{
              height:
                isMobile && !showTopNavigation
                  ? "calc(100vh - 215px)"
                  : isMobile && showTopNavigation
                  ? "calc(100vh - 225px)"
                  : undefined,
            }}
            className={clsx(
              isMobile && showTopNavigation && "mt-2",
              isMobile && !showTopNavigation && "mt-8",
              "grid place-content-center text-center items-center gap-4 overflow-hidden"
            )}
          >
            {!(sharedChatId || sharedPrompt) ? (
              <>
                <Header tagline={tagline} />
                {isMobile ? null : (
                  <div className="pb-8">
                    <SuggestedPrompts addPromptInput={addPromptInput} suggestions={suggestions} embedded={embedded} />
                  </div>
                )}
              </>
            ) : null}
          </div>
        );
      case "chat":
        // We only want to process the chat messages that are either strings or valid widgets.
        // The API currently sends back other function calls that we currently do not support or don't need to support,
        // so we filter those out by checking if they are in the component registry.
        const chatMessagesToProcess = chat.filter(
          (c) => typeof c.content === "string" || componentRegistry.has(c.content.name)
        );

        const loaderIndex = chatMessagesToProcess.findLastIndex((c) => c.author === "You");

        return (
          <>
            <div
              role="feed"
              aria-label="StarSearch conversation"
              aria-busy={isRunning}
              className={clsx("w-full max-w-xl mx-auto lg:max-w-5xl pb-[210px] md:pb-[285px]")}
            >
              {chatMessagesToProcess.map((message, i, messages) => {
                if (loaderIndex === i && isRunning && messages.length - 1 === i) {
                  return (
                    <Fragment key={i}>
                      <Chatbox
                        userId={userId}
                        message={message}
                        componentRegistry={componentRegistry}
                        embedded={embedded}
                      />
                      <div className="flex items-center gap-2 my-4 w-max">
                        <ChatAvatar author="StarSearch" userId={userId} />
                        <StarSearchLoader />
                      </div>
                    </Fragment>
                  );
                } else {
                  return (
                    <Chatbox
                      key={i}
                      userId={userId}
                      message={message}
                      componentRegistry={componentRegistry}
                      embedded={embedded}
                    />
                  );
                }
              })}
              <div className={clsx("text-slate-600 flex gap-4 items-center justify-end", isRunning && "invisible")}>
                {workspaceId ? null : (
                  <button
                    type="button"
                    className="flex items-center gap-2 hover:text-sauced-orange"
                    onClick={clearChatHistory}
                  >
                    Clear chat history
                    <TrashIcon width={18} height={18} />
                  </button>
                )}
                <span className="flex gap-1">
                  <button
                    type="button"
                    className="flex items-center gap-2 hover:text-sauced-orange"
                    onClick={() => {
                      registerFeedback("positive");
                    }}
                  >
                    <span className="sr-only">Thumbs up</span>
                    <ThumbsupIcon size={16} />
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-2 hover:text-sauced-orange"
                    onClick={() => {
                      registerFeedback("negative");
                    }}
                  >
                    <span className="sr-only">Thumbs down</span>
                    <ThumbsdownIcon size={16} />
                  </button>
                  {sharingEnabled ? (
                    <div className="flex items-center gap-2 pl-4 hover:text-sauced-orange">
                      <ShareChatMenu
                        createLink={
                          threadHistory?.is_publicly_viewable
                            ? undefined
                            : async () => {
                                setShareLinkError(false);

                                try {
                                  parseSchema(UuidSchema, chatId);
                                } catch (error) {
                                  captureException(
                                    new Error(`Failed to parse UUID for StarSearch. UUID: ${chatId}`, {
                                      cause: error,
                                    })
                                  );
                                  toast({
                                    description: "Failed to create a share link",
                                    variant: "danger",
                                  });
                                  return;
                                }

                                const response = await fetch(
                                  `${process.env.NEXT_PUBLIC_API_URL}/star-search/${chatId}/share`,
                                  {
                                    body: "",
                                    method: "POST",
                                    headers: {
                                      Authorization: `Bearer ${bearerToken}`,
                                    },
                                  }
                                );

                                if (response.status == 201) {
                                  toast({
                                    description: "Share link created",
                                    variant: "success",
                                  });
                                  // Causes a re-fetch of the thread history so the hook reruns
                                  // and gets the public_link and is_publicly_viewable property updates
                                  mutateThreadHistory(undefined, true);
                                } else {
                                  setShareLinkError(true);
                                  toast({
                                    description: "Failed to create a share link",
                                    variant: "danger",
                                  });
                                }
                              }
                        }
                        shareUrl={threadHistory?.public_link}
                        copyLinkHandler={async (url: string) => {
                          await writeToClipboard(url);
                          toast({
                            description: "Link copied to clipboard",
                            variant: "success",
                          });
                        }}
                        error={shareLinkError}
                      />
                    </div>
                  ) : null}
                </span>
              </div>
            </div>
          </>
        );

      case "history":
        return (
          <StarSearchHistory
            history={starSearchHistory}
            onLoadThread={(conversationId) => {
              onNewChat();
              setStarSearchState("chat");
              setChatId(conversationId);
            }}
            onDeleteThread={deleteStarSearchThread}
            onNewChat={onNewChat}
            loadMore={loadMore}
          />
        );

      default:
        throw new Error(`Invalid StarSearch state: ${starSearchState}`);
    }
  };

  return (
    <>
      {showTopNavigation ? (
        <StarSearchCompactHeader
          onBack={onNewChat}
          onClose={() => {
            onClose?.();
          }}
          onShowHistory={() => {
            setStarSearchState("history");
          }}
          onNewChat={onNewChat}
        />
      ) : null}
      <div
        className={clsx(
          isMobile && showTopNavigation && "overflow-y-auto",
          embedded && "overflow-y-auto overflow-x-hidden self-start w-full"
        )}
      >
        {showTopNavigation ? null : (
          <div className="fixed inset-x-0 top-20 h-[125px] w-full translate-y-[-100%] lg:translate-y-[-50%] rounded-full bg-gradient-to-r from-light-red-10 via-sauced-orange to-amber-400 opacity-20 opa blur-[40px]" />
        )}
        <div
          className="star-search relative -mt-1.5 flex flex-col px-2 justify-between items-center w-full h-full grow"
          data-is-embedded={embedded}
        >
          {renderState()}
        </div>
      </div>
      <div className="fixed w-full bottom-0 h-fit">
        <div className="h-8 bg-gradient-to-t from-light-slate-2 to-transparent" />
        {starSearchState === "history" ? null : (
          <div className="bg-light-slate-2">
            {!isRunning &&
              (isMobile ? (
                <Drawer
                  title="Choose a suggestion"
                  description="You can customize the prompt after selection"
                  showCloseButton
                  trigger={
                    <button
                      onClick={() => setShowSuggestions(!showSuggestions)}
                      className="mx-auto w-fit flex gap-1 shadow-xs items-center text-slate-700 font-medium bg-slate-100 !border-2 !border-slate-300 px-4 py-1 rounded-full mb-2 md:mb-4"
                    >
                      Need inspiration?
                      <BsArrowUpShort className="text-2xl" />
                    </button>
                  }
                >
                  <SuggestedPrompts addPromptInput={addPromptInput} suggestions={suggestions} />
                </Drawer>
              ) : (
                <>
                  {!showSuggestions && ranOnce && (
                    <button
                      onClick={() => setShowSuggestions(!showSuggestions)}
                      className="mx-auto w-fit flex gap-1 shadow-xs items-center text-slate-700 font-medium bg-slate-100 !border-2 !border-slate-300 px-4 py-1 rounded-full mb-2 md:mb-4"
                    >
                      Need inspiration?
                      <BsArrowUpShort className="text-2xl" />
                    </button>
                  )}
                </>
              ))}
            {!isMobile && showSuggestions && (
              <div className="relative flex flex-col gap-2 mx-auto mb-4 w-fit">
                <button
                  onClick={() => {
                    setShowSuggestions(false);
                    inputRef.current?.focus();
                  }}
                  className="absolute flex self-end gap-2 w-fit -right-5 -top-3"
                >
                  <XCircleIcon className="w-5 h-5 text-slate-400" aria-label="Close suggestions" />
                </button>
                <SuggestedPrompts
                  isHorizontal
                  addPromptInput={(prompt) => {
                    addPromptInput(prompt);
                    setShowSuggestions(false);
                  }}
                  suggestions={suggestions}
                />
              </div>
            )}
            {sharedChatId ? (
              <div className="flex items-center justify-center gap-2 p-2">
                <p>This is a shared conversation and cannot be added to.</p>
                <Button variant="primary" onClick={clearChatHistory}>
                  Start a Conversation
                </Button>
              </div>
            ) : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const formData = new FormData(form);
                submitPrompt(formData.get("prompt") as string);
                form.reset();
              }}
              className={clsx(
                "bg-white flex justify-between mx-1 lg:max-w-3xl p-[3px] rounded-[11px] bg-gradient-to-r from-sauced-orange via-amber-400 to-sauced-orange",
                embedded ? "mx-1" : "md:mx-4 lg:mx-auto"
              )}
            >
              <input
                required
                type="text"
                name="prompt"
                ref={inputRef}
                disabled={isRunning || !!sharedChatId}
                placeholder="Ask a question"
                className="p-4 bg-white border border-none rounded-l-lg focus:outline-none grow"
                onFocus={() => {
                  if ((checkAuth && sharedChatId && !bearerToken) || (!bearerToken && !sharedChatId)) {
                    setLoginModalOpen(true);
                  }
                }}
              />
              <button type="submit" disabled={isRunning || !!sharedChatId} className="p-2 bg-white rounded-r-lg">
                <span className="sr-only">Submit your question to StarSearch</span>
                <MdOutlineSubdirectoryArrowRight className="w-10 h-10 p-2 rounded-lg bg-light-orange-3 text-light-orange-10" />
              </button>
            </form>
            <p className="py-2 text-sm text-center text-slate-400">
              {isMobile ? (
                <>StarSearch may generate incorrect responses</>
              ) : (
                <>StarSearch may generate incorrect responses, double check important information</>
              )}
            </p>
          </div>
        )}
      </div>
      <StarSearchLoginModal isOpen={loginModalOpen} onClose={() => setLoginModalOpen(false)} />
    </>
  );
}

function Header({ tagline }: { tagline: string }) {
  return (
    <header className="mt-4 flex flex-col items-center gap-2 text-center lg:gap-4 lg:pt-8">
      <div className="flex items-center gap-2">
        <Image src="/assets/star-search-logo.svg" alt="" width={40} height={40} />
        <h1 className="text-3xl font-bold text-transparent lg:text-4xl bg-clip-text bg-gradient-to-r from-sauced-orange to-amber-400">
          StarSearch
        </h1>
      </div>
      <h2 className="pt-1 text-3xl font-semibold lg:text-4xl text-slate-600">{tagline}</h2>
    </header>
  );
}

/**
 * Workspace Chat page — viewport and durable conversation integration coverage.
 *
 * The full-height chat frame is anchored to the dynamic viewport while keeping a
 * single workspace/header/composer hierarchy.
 * Demo mode is a top-bar chip (R12) — the AppShell no longer injects a full-width
 * banner + `mt-4` spacer above the page, so the frame subtracts exactly one band in
 * every tenant state and the composer never moves. These tests pin that the offset no
 * longer switches with `useDemo().active`, while the integration
 * cases lock the per-user conversation rail, selection restore, thread actions,
 * New-chat draft behavior, case scoping, and populated accessibility.
 *
 * ChatPanel is mocked to a trivial stub so no chat engine / network is pulled in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe, toHaveNoViolations } from "jest-axe";

import type {
  ChatConversation,
  ChatConversationSummary,
} from "@/lib/types";
import { ConfirmProvider } from "@/soc/components/ConfirmDialog";

expect.extend(toHaveNoViolations);

const {
  demoActiveRef,
  resetMock,
  chatConversationsMock,
  chatConversationMock,
  renameChatConversationMock,
  deleteChatConversationMock,
} = vi.hoisted(() => ({
  demoActiveRef: { current: false },
  resetMock: vi.fn(),
  chatConversationsMock: vi.fn(),
  chatConversationMock: vi.fn(),
  renameChatConversationMock: vi.fn(),
  deleteChatConversationMock: vi.fn(),
}));

vi.mock("@/soc/demo", () => ({
  useDemo: () => ({
    status: {
      mode: demoActiveRef.current ? "seeded" : "off",
      active: demoActiveRef.current,
      run_id: null,
    },
    active: demoActiveRef.current,
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/soc/components/ChatPanel", async () => {
  const React = await import("react");
  return {
    ChatPanel: React.forwardRef((props: {
      presentation?: string;
      caseId?: string;
      persistConversation?: boolean;
      conversation?: ChatConversation | null;
      restoring?: boolean;
      draft?: string;
      onDraftChange?: (value: string) => void;
      workspaceRetentionNote?: string | null;
      onConversationPersisted?: (id: string, title: string) => void;
    }, ref) => {
      React.useImperativeHandle(ref, () => ({ reset: resetMock }));
      return React.createElement(
        "div",
        {
          "data-testid": "chat-panel",
          "data-presentation": props.presentation,
          "data-conversation-id": props.conversation?.id ?? "new",
          "data-restoring": String(props.restoring ?? false),
          "data-case-id": props.caseId ?? "",
          "data-persist-conversation": String(props.persistConversation ?? false),
        },
        React.createElement(
          "button",
          {
            type: "button",
            onClick: () =>
              props.onConversationPersisted?.(
                props.conversation?.id ?? "conversation-new",
                props.conversation?.title ?? "New investigation",
              ),
          },
          "Simulate persisted turn",
        ),
        React.createElement("input", {
          "aria-label": "Mock chat draft",
          value: props.draft ?? "",
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            props.onDraftChange?.(event.target.value),
        }),
        props.workspaceRetentionNote
          ? React.createElement(
              "div",
              { role: "note" },
              props.workspaceRetentionNote,
            )
          : null,
      );
    }),
  };
});

vi.mock("@/lib/api", () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      chatConversations: chatConversationsMock,
      chatConversation: chatConversationMock,
      renameChatConversation: renameChatConversationMock,
      deleteChatConversation: deleteChatConversationMock,
    },
  };
});

import Chat from "../Chat";

const OLDER: ChatConversationSummary = {
  id: "conversation-older",
  title: "Older endpoint review",
  preview: "Older answer",
  created_at: "2026-07-26T08:00:00Z",
  updated_at: "2026-07-26T08:02:00Z",
  message_count: 2,
};

const NEWEST: ChatConversationSummary = {
  id: "conversation-newest",
  title: "Newest sign-in review",
  preview: "Newest answer",
  created_at: "2026-07-26T09:00:00Z",
  updated_at: "2026-07-26T09:03:00Z",
  message_count: 4,
};

const CREATED: ChatConversationSummary = {
  id: "conversation-new",
  title: "New investigation",
  preview: "New answer",
  created_at: "2026-07-26T10:00:00Z",
  updated_at: "2026-07-26T10:01:00Z",
  message_count: 2,
};

function detail(row: ChatConversationSummary): ChatConversation {
  return {
    ...row,
    messages: [
      {
        id: `${row.id}-user`,
        role: "user",
        content: `${row.title} question`,
        created_at: row.created_at,
      },
      {
        id: `${row.id}-assistant`,
        role: "assistant",
        content: row.preview ?? "Answer",
        created_at: row.updated_at,
        response: { answer: row.preview ?? "Answer" },
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderChat(props: React.ComponentProps<typeof Chat> = {}) {
  return render(
    <ConfirmProvider>
      <Chat {...props} />
    </ConfirmProvider>,
  );
}

/** The outer full-height frame is the render container's first element child. */
function frameClass(container: HTMLElement): string {
  return (container.firstElementChild as HTMLElement).className;
}

describe("Chat page — Demo Mode height", () => {
  beforeEach(() => {
    demoActiveRef.current = false;
    resetMock.mockReset();
    chatConversationsMock.mockReset();
    chatConversationMock.mockReset();
    renameChatConversationMock.mockReset();
    deleteChatConversationMock.mockReset();
    chatConversationsMock.mockResolvedValue({ conversations: [OLDER, NEWEST] });
    chatConversationMock.mockImplementation((id: string) => {
      const row = [OLDER, NEWEST, CREATED].find((item) => item.id === id);
      return Promise.resolve(detail(row ?? NEWEST));
    });
    renameChatConversationMock.mockImplementation(
      (id: string, title: string) =>
        Promise.resolve({
          ...([OLDER, NEWEST].find((item) => item.id === id) ?? NEWEST),
          title,
        }),
    );
    deleteChatConversationMock.mockResolvedValue({ ok: true });
  });

  it("fills the routed workspace when demo is off", async () => {
    const { container } = renderChat();
    const cls = frameClass(container);
    expect(cls).toContain("h-[calc(100dvh-5.5rem)]");
    expect(cls).toContain("min-h-0");
    expect(cls).not.toContain("sm:min-h-[34rem]");
    expect(screen.getByTestId("workspace-chat-frame")).toBeInTheDocument();
    await screen.findByTestId("chat-panel");
  });

  it("keeps the same frame height when demo is active (no banner band)", async () => {
    demoActiveRef.current = true;
    const { container } = renderChat();
    const cls = frameClass(container);
    expect(cls).toContain("h-[calc(100dvh-5.5rem)]");
    expect(cls).not.toContain("h-[calc(100dvh-10rem)]");
    await screen.findByTestId("chat-panel");
  });

  it("renders one page heading and keeps New chat in the page header", async () => {
    renderChat();

    expect(
      screen.getAllByRole("heading", { level: 1, name: "Chat" }),
    ).toHaveLength(1);
    const newChat = screen.getByRole("button", { name: "New chat" });
    expect(newChat.closest("section")).toContainElement(
      screen.getByRole("heading", { level: 1, name: "Chat" }),
    );
    await screen.findByTestId("chat-panel");
  });

  it("uses the workspace presentation and resets from the header action", async () => {
    renderChat();

    await waitFor(() =>
      expect(screen.getByTestId("chat-panel")).toHaveAttribute(
        "data-conversation-id",
        "conversation-newest",
      ),
    );
    expect(screen.getByTestId("chat-panel")).toHaveAttribute(
      "data-presentation",
      "workspace",
    );
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("chat-panel")).toHaveAttribute(
      "data-conversation-id",
      "new",
    );
  });

  it("sorts newest first, marks the selected row, and restores another transcript", async () => {
    renderChat();

    await waitFor(() =>
      expect(chatConversationMock).toHaveBeenCalledWith("conversation-newest"),
    );
    const history = screen.getByRole("navigation", { name: "Conversation history" });
    const newest = within(history).getByRole("button", {
      name: /^Newest sign-in review .* messages$/i,
    });
    const older = within(history).getByRole("button", {
      name: /^Older endpoint review .* messages$/i,
    });
    expect(newest).toHaveAttribute("aria-current", "page");
    expect(
      newest.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId("chat-panel")).toHaveAttribute(
      "data-conversation-id",
      "conversation-newest",
    );

    fireEvent.click(older);
    await waitFor(() =>
      expect(chatConversationMock).toHaveBeenCalledWith("conversation-older"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-panel")).toHaveAttribute(
        "data-conversation-id",
        "conversation-older",
      ),
    );
    expect(older).toHaveAttribute("aria-current", "page");
  });

  it("ignores a stale detail response after the operator selects another conversation", async () => {
    const newestDetail = deferred<ChatConversation>();
    const olderDetail = deferred<ChatConversation>();
    chatConversationMock.mockImplementation((id: string) =>
      id === NEWEST.id ? newestDetail.promise : olderDetail.promise,
    );
    renderChat();

    await waitFor(() =>
      expect(chatConversationMock).toHaveBeenCalledWith(NEWEST.id),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /^Older endpoint review .* messages$/i,
      }),
    );
    expect(screen.getByTestId("chat-panel")).toHaveAttribute(
      "data-conversation-id",
      "new",
    );
    expect(screen.getByTestId("chat-panel")).toHaveAttribute(
      "data-restoring",
      "true",
    );
    await waitFor(() =>
      expect(chatConversationMock).toHaveBeenCalledWith(OLDER.id),
    );

    await act(async () => {
      olderDetail.resolve(detail(OLDER));
      await olderDetail.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("chat-panel")).toHaveAttribute(
        "data-conversation-id",
        OLDER.id,
      ),
    );

    await act(async () => {
      newestDetail.resolve(detail(NEWEST));
      await newestDetail.promise;
    });
    expect(screen.getByTestId("chat-panel")).toHaveAttribute(
      "data-conversation-id",
      OLDER.id,
    );
  });

  it("promotes a first persisted turn into the saved rail without creating an empty draft", async () => {
    chatConversationsMock
      .mockResolvedValueOnce({ conversations: [OLDER, NEWEST] })
      .mockResolvedValueOnce({ conversations: [OLDER, NEWEST, CREATED] });
    renderChat();
    await screen.findByTestId("chat-panel");

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(
      screen.queryByRole("button", { name: /New investigation.*messages/i }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Simulate persisted turn" }));

    await waitFor(() => expect(chatConversationsMock).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("button", {
        name: /^New investigation .* · 2 messages$/i,
      }),
    ).toHaveAttribute("aria-current", "page");
    // The live panel keeps the locally-returned answer; the new thread is not
    // immediately refetched/remounted just to hydrate the rail.
    expect(chatConversationMock).not.toHaveBeenCalledWith("conversation-new");
  });

  it("hydrates an active thread again after a later persisted turn, switch away, and return", async () => {
    renderChat();
    await waitFor(() =>
      expect(screen.getByTestId("chat-panel")).toHaveAttribute(
        "data-conversation-id",
        NEWEST.id,
      ),
    );

    // A later reply is persisted into the thread that is already active. This must
    // not leave behind the first-turn hydration skip token.
    fireEvent.click(screen.getByRole("button", { name: "Simulate persisted turn" }));
    await waitFor(() => expect(chatConversationsMock).toHaveBeenCalledTimes(2));

    fireEvent.click(
      screen.getByRole("button", {
        name: /^Older endpoint review .* messages$/i,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-panel")).toHaveAttribute(
        "data-conversation-id",
        OLDER.id,
      ),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /^Newest sign-in review .* messages$/i,
      }),
    );
    await waitFor(() => {
      expect(
        chatConversationMock.mock.calls.filter(([id]) => id === NEWEST.id),
      ).toHaveLength(2);
      expect(screen.getByTestId("chat-panel")).toHaveAttribute(
        "data-conversation-id",
        NEWEST.id,
      );
    });
  });

  it("routes rename and confirmed delete actions through the conversation API", async () => {
    const user = userEvent.setup();
    renderChat();
    await screen.findByTestId("chat-panel");

    await user.click(
      screen.getByRole("button", { name: "Actions for Older endpoint review" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const rename = screen.getByRole("textbox", { name: "Rename Older endpoint review" });
    await user.clear(rename);
    await user.type(rename, "Endpoint review complete{Enter}");
    await waitFor(() =>
      expect(renameChatConversationMock).toHaveBeenCalledWith(
        "conversation-older",
        "Endpoint review complete",
      ),
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Endpoint review complete" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deleteChatConversationMock).toHaveBeenCalledWith("conversation-older"),
    );
  });

  it("preserves one unsent draft for each saved thread and the new-chat draft", async () => {
    const user = userEvent.setup();
    renderChat();
    await waitFor(() =>
      expect(screen.getByTestId("chat-panel")).toHaveAttribute(
        "data-conversation-id",
        NEWEST.id,
      ),
    );

    const draft = screen.getByRole("textbox", { name: "Mock chat draft" });
    await user.type(draft, "newest unfinished");
    await user.click(
      screen.getByRole("button", { name: /^Older endpoint review .* messages$/i }),
    );
    await waitFor(() => expect(draft).toHaveValue(""));
    await user.type(draft, "older unfinished");

    await user.click(
      screen.getByRole("button", { name: /^Newest sign-in review .* messages$/i }),
    );
    await waitFor(() => expect(draft).toHaveValue("newest unfinished"));

    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(draft).toHaveValue("");
    await user.type(draft, "fresh investigation draft");
    await user.click(
      screen.getByRole("button", { name: /^Older endpoint review .* messages$/i }),
    );
    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(draft).toHaveValue("fresh investigation draft");
  });

  it("renders server-reported conversation and message retention boundaries", async () => {
    const retainedNewest = {
      ...NEWEST,
      message_count: 100,
      total_message_count: 148,
      history_truncated: true,
    };
    chatConversationsMock.mockResolvedValueOnce({
      conversations: [retainedNewest],
      limit: 50,
      total: 50,
      total_conversation_count: 64,
      history_truncated: true,
    });
    chatConversationMock.mockResolvedValueOnce({
      ...detail(retainedNewest),
      message_count: 100,
      total_message_count: 148,
      history_truncated: true,
    });
    renderChat();

    expect(
      await screen.findByText(/Showing the latest 1 of 64 conversations/i),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Showing the latest 100 of 148 messages/i),
    ).toBeInTheDocument();
  });

  it("refreshes the rail conservatively on focus and cross-tab history signals", async () => {
    const channels: Array<{
      onmessage: ((event: MessageEvent) => void) | null;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    const OriginalBroadcastChannel = window.BroadcastChannel;
    class FakeBroadcastChannel {
      onmessage: ((event: MessageEvent) => void) | null = null;
      close = vi.fn();
      postMessage = vi.fn();
      constructor(_name: string) {
        channels.push(this);
      }
    }
    Object.defineProperty(window, "BroadcastChannel", {
      configurable: true,
      value: FakeBroadcastChannel,
    });

    try {
      renderChat();
      await waitFor(() => expect(chatConversationsMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(channels).toHaveLength(1));

      act(() => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(chatConversationsMock).toHaveBeenCalledTimes(2));

      act(() =>
        channels[0].onmessage?.(
          new MessageEvent("message", { data: { type: "history-changed" } }),
        ),
      );
      await waitFor(() => expect(chatConversationsMock).toHaveBeenCalledTimes(3));
    } finally {
      Object.defineProperty(window, "BroadcastChannel", {
        configurable: true,
        value: OriginalBroadcastChannel,
      });
    }
  });

  it("passes case scope through while disabling Workspace persistence", async () => {
    renderChat({ caseId: "case-123" });
    const panel = await screen.findByTestId("chat-panel");
    expect(panel).toHaveAttribute("data-case-id", "case-123");
    expect(panel).toHaveAttribute("data-persist-conversation", "false");
    expect(panel).toHaveAttribute("data-conversation-id", "new");
    expect(chatConversationsMock).not.toHaveBeenCalled();
    expect(chatConversationMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("navigation", { name: "Conversation history" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
  });

  it("has no detectable accessibility violations with populated history", async () => {
    const { container } = renderChat();
    await waitFor(() =>
      expect(screen.getByTestId("chat-panel")).toHaveAttribute(
        "data-conversation-id",
        "conversation-newest",
      ),
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

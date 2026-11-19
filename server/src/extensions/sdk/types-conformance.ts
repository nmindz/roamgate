// Type-level only: fails the typecheck when types.d.ts, which mods see,
// drifts from the shapes Roamgate actually uses.

import type * as SdkTesting from "roamgate:testing";
import type * as Sdk from "roamgate";
import type {
  ActionEventName,
  BadgeSlotData,
  ChildLogParams,
  CommandSlotData,
  ComposerCommandSlotData,
  ContextMenuSlotData,
  El,
  ElementTone,
  ExtensionCapability,
  ExtensionEventBase,
  ExtensionEventName,
  ExtensionManifest,
  ExtensionMatcher,
  ExtensionPlatform,
  ExtensionSlot,
  ExtensionSlotContext,
  Gate,
  StatusBarSlotData,
  ToastSlotData,
} from "../../../../shared/extensions";
import type * as Testing from "./testing";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type SdkConformance = [
  Assert<Same<Sdk.Capability, ExtensionCapability>>,
  Assert<Same<Sdk.Platform, ExtensionPlatform>>,
  Assert<Same<Sdk.Matcher, ExtensionMatcher>>,
  Assert<Same<Sdk.Manifest, ExtensionManifest>>,
  Assert<Same<Sdk.EventName, ExtensionEventName>>,
  Assert<Same<Sdk.ActionEventName, ActionEventName>>,
  Assert<Same<keyof Sdk.Answers, ExtensionEventName>>,
  Assert<Same<Sdk.EventBase, ExtensionEventBase>>,
  Assert<Same<Sdk.SlotContext, ExtensionSlotContext>>,
  Assert<Same<Sdk.Gate, Gate>>,
  Assert<Same<Sdk.Slot, ExtensionSlot>>,
  Assert<Same<Sdk.Tone, ElementTone>>,
  Assert<Same<Sdk.Element, El>>,
  Assert<Same<Sdk.CommandSlotData, CommandSlotData>>,
  Assert<Same<Sdk.BadgeSlotData, BadgeSlotData>>,
  Assert<Same<Sdk.ContextMenuSlotData, ContextMenuSlotData>>,
  Assert<Same<Sdk.StatusBarSlotData, StatusBarSlotData>>,
  Assert<Same<Sdk.ComposerCommandSlotData, ComposerCommandSlotData>>,
  Assert<Same<Sdk.ToastSlotData, ToastSlotData>>,
  Assert<Same<SdkTesting.FakeLog, ChildLogParams>>,
  Assert<Same<SdkTesting.FakeCall, Testing.FakeCall>>,
  Assert<Same<SdkTesting.FakeAsk, Testing.FakeAsk>>,
  Assert<Same<SdkTesting.FakeAskAnswer, Testing.FakeAskAnswer>>,
  Assert<Same<SdkTesting.FakeHostOptions, Testing.FakeHostOptions>>,
  Assert<Same<SdkTesting.FakeEvent, Testing.FakeEvent>>,
  Assert<Same<SdkTesting.FakeOutcome, Testing.FakeOutcome>>,
  Assert<Same<SdkTesting.FakeHost, Testing.FakeHost>>,
  Assert<Same<typeof SdkTesting.createFakeHost, typeof Testing.createFakeHost>>,
  Assert<Same<keyof typeof SdkTesting, keyof typeof Testing>>,
];

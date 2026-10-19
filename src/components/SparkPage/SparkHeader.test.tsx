import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { OVERVIEW_ID } from "../../constants";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import { SparkHeader } from "./SparkHeader";

describe("SparkHeader back link", () => {
  it("goes back to the overview when onNavigate is passed", () => {
    const onNavigate = vi.fn();
    const { container } = render(<SparkHeader spark={makeSpark()} onNavigate={onNavigate} />);
    const back = container.querySelector<HTMLButtonElement>("button.sp-back");
    expect(back).not.toBeNull();
    act(() => back!.click());
    expect(onNavigate).toHaveBeenCalledWith(OVERVIEW_ID);
  });

  it("renders no link without onNavigate", () => {
    const { container } = render(<SparkHeader spark={makeSpark()} />);
    expect(container.querySelector("button.sp-back")).toBeNull();
  });
});

describe("SparkHeader software line", () => {
  const software = { driver: "580.95.05", cuda: null, kernel: "6.11.0-1016-nvidia", os: "Ubuntu 24.04.3 LTS", dgxOs: "7.2.3", collectedAt: 1 };

  it("shows the known versions and skips missing ones", () => {
    const spark = makeSpark();
    spark.software = software;
    const { container } = render(<SparkHeader spark={spark} />);
    const text = container.querySelector(".sp-header__software")?.textContent ?? "";
    expect(text).toContain("Driver 580.95.05");
    expect(text).toContain("Kernel 6.11.0-1016-nvidia");
    expect(text).toContain("DGX OS 7.2.3");
    expect(text).not.toContain("CUDA");
    expect(container.querySelector(".sp-header__software .text-warning")).toBeNull();
  });

  it("marks a drifting value and names the head's version", () => {
    const spark = makeSpark("spark-2");
    spark.software = software;
    const drift = { headId: "spark-1", headName: "Spark spark-1", diffs: [{ field: "driver" as const, label: "driver", value: "580.95.05", headValue: "580.82.07" }] };
    const { container } = render(<SparkHeader spark={spark} drift={drift} />);
    const marked = container.querySelectorAll(".sp-header__software .text-warning");
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toBe("Driver 580.95.05");
    expect(marked[0].getAttribute("title")).toBe("Spark spark-1 has 580.82.07");
  });

  it("renders no line before versions are known", () => {
    const { container } = render(<SparkHeader spark={makeSpark()} />);
    expect(container.querySelector(".sp-header__software")).toBeNull();
  });
});

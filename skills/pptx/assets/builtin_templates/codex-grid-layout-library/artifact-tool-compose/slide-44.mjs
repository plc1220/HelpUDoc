import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide44Tokens = contentTokens["slide-44"];

export function buildSlide44(presentation, tokens = slide44Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-44", width: "fill", height: "fill" }, [
      text([tokens.body1.titleGoesHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-9",
        ...frame({ left: "41px", top: "213px", width: "581px", height: "173px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-1",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.body2.titleGoesHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "657px", top: "213px", width: "581px", height: "173px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.title], {
        name: "Title-2",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.body3.titleGoesHere, tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-9",
        ...frame({ left: "41px", top: "422px", width: "581px", height: "173px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body4.titleGoesHere, tokens.body4.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "657px", top: "422px", width: "581px", height: "173px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

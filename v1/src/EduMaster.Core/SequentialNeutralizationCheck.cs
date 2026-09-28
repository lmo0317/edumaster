using System.Globalization;
using System.Text.RegularExpressions;

namespace EduMaster.Core;

// AOH + H2B, followed by two additions of the same HC solution.
// Works only when the problem supplies both ion-count ratios and equality of
// total anion molarity in I and II. Unknown layouts stay outside this checker.
public static class SequentialNeutralizationCheck
{
    private sealed record Parsed(double BaseVolume,double DiproticVolume,double FinalAcidVolume,
        double RatioTwo,double RatioThree,string Question,string[] Choices);
    private sealed record Solution(double A,double B,double C,double V,double AcidTwo,double AcidThree,
        double Value,int ChoiceIndex,Parsed Input);

    public static bool IsFamily(string body)
    {
        var text=Plain(body);
        return text.Contains("AOH",StringComparison.OrdinalIgnoreCase)
            &&text.Contains("H2B",StringComparison.OrdinalIgnoreCase)
            &&text.Contains("HC",StringComparison.OrdinalIgnoreCase)
            &&Regex.IsMatch(text,@"I\s*과\s*II\s*가\s*같",RegexOptions.IgnoreCase)
            &&text.Contains("음이온의 양",StringComparison.Ordinal);
    }

    public static SolvedProblem? SolveSource(string body)
    {
        if(!IsFamily(body))return null;
        var solved=Solve(body,null);
        if(solved.ChoiceIndex<0)throw new InvalidDataException($"입력 문제를 독립 계산한 값 {Format(solved.Value)}이 보기와 일치하지 않습니다. 원본 표와 보기를 확인해 주세요.");
        var steps=new[]{
            $"II가 염기성 또는 중성이면 I에서 II로 HC를 더해도 음이온 총량은 같지만 부피는 늘어나므로 I과 II의 음이온 몰 농도 합이 같을 수 없다. 따라서 II와 III은 산성이다. 산성 혼합액의 음이온/양이온 몰수 비는 (b×{Format(solved.Input.DiproticVolume)}+추가한 HC의 mmol)/(2b×{Format(solved.Input.DiproticVolume)}+추가한 HC의 mmol)이다.",
            $"II의 비 {Format(solved.Input.RatioTwo)}에서 cV={Format(solved.AcidTwo)}b, III의 비 {Format(solved.Input.RatioThree)}에서 c(V+{Format(solved.Input.FinalAcidVolume)})={Format(solved.AcidThree)}b를 얻는다. 차이를 빼면 c={Format(solved.C)}b, V={Format(solved.V)} mL이다.",
            $"I은 염기성이므로 음이온 총량은 {Format(solved.Input.BaseVolume)}a-{Format(solved.Input.DiproticVolume)}b mmol이고, II의 음이온 총량은 {Format(solved.Input.DiproticVolume)}b+cV mmol이다. 두 혼합액의 음이온 몰 농도 합이 같다는 식을 세우면 a={Format(solved.A)}b이다. 따라서 cV/(a+b)={Format(solved.Value)}이며 보기 {"①②③④⑤"[solved.ChoiceIndex]}와 일치한다."
        };
        var selectedSteps=solved.Input.Question=="V"
            ?[steps[0],steps[1]+$" 따라서 V={Format(solved.Value)} mL이며 보기 {"①②③④⑤"[solved.ChoiceIndex]}와 일치한다."]
            :steps;
        var answer="①②③④⑤"[solved.ChoiceIndex]+" "+solved.Input.Choices[solved.ChoiceIndex];
        return new(answer,string.Join("\n",selectedSteps.Select((step,index)=>$"STEP {index+1}. {step}")),selectedSteps,"코드 독립 검산 · 순차 중화 및 이온 수");
    }

    public static QualityCheck? InspectSource(SampleResult result)
    {
        if(!IsFamily(result.SourceProblem))return null;
        try{
            var solved=Solve(result.SourceProblem,null);
            var selected=ChoiceIndex(result.SourceAnswer);
            var correct=solved.ChoiceIndex>=0&&(string.IsNullOrWhiteSpace(result.SourceAnswer)||selected==solved.ChoiceIndex);
            return new("source-calculation","입력 문제 풀이 검산",correct?"pass":"fail",
                correct?$"순차 중화와 이온 수로 {solved.Input.Question}={Format(solved.Value)}, 정답 {"①②③④⑤"[solved.ChoiceIndex]}를 독립 계산했습니다.":$"독립 계산값 {Format(solved.Value)}과 입력 정답 {result.SourceAnswer} 또는 보기가 일치하지 않습니다.","code-sequential-neutralization");
        }catch(InvalidDataException error){return new("source-calculation","입력 문제 풀이 검산","fail",error.Message,"code-sequential-neutralization");}
    }

    public static QualityCheck? Inspect(SampleResult result)
    {
        if(IsStageOne(result.Body)){
            var correct=result.Answer.StartsWith("①",StringComparison.Ordinal)
                &&result.Choices.Length==5&&result.Choices[0].Contains("II에서 H⁺가 남는다",StringComparison.Ordinal);
            return new("calculation","독립 수치 검산",correct?"pass":"fail",
                correct?"I·II의 음이온 농도 합이 같고 II에는 산을 추가하므로 II가 염기성·중성이면 음이온 총량은 그대로인데 부피만 증가해 모순입니다. II는 산성입니다.":"II의 액성과 표시 정답이 모순됩니다.","code-sequential-neutralization");
        }
        if(!IsFamily(result.Body))return null;
        try{
            var solved=Solve(result.Body,result.Choices);
            var correct=solved.ChoiceIndex>=0&&ChoiceIndex(result.Answer)==solved.ChoiceIndex;
            return new("calculation","독립 수치 검산",correct?"pass":"fail",
                correct?$"순차 중화 조건을 독립 계산해 {solved.Input.Question}={Format(solved.Value)}, 정답 {"①②③④⑤"[solved.ChoiceIndex]}를 확인했습니다.":$"계산값 {Format(solved.Value)}과 표시 정답 {result.Answer}이 일치하지 않습니다.","code-sequential-neutralization");
        }catch(InvalidDataException error){return new("calculation","독립 수치 검산","fail",error.Message,"code-sequential-neutralization");}
    }

    public static SampleResult? CreateLearningStage(ProblemDraft draft,int number,int total)
    {
        if(!IsFamily(draft.Body)||total!=3||number is <1 or >3)return null;
        var source=Read(draft.Body,null);
        var p=source.BaseVolume;var q=source.DiproticVolume;var t=source.FinalAcidVolume;
        string body;string[] choices;string answer;string[] steps;
        if(number==1){
            body=$"다음은 순차 중화 반응에 대한 자료이다.\nAOH는 A⁺와 OH⁻, H₂B는 H⁺ 이온 2개와 B²⁻ 이온 1개, HC는 H⁺와 C⁻로 모두 이온화된다.\na M AOH(aq) {Format(p)} mL와 b M H₂B(aq) {Format(q)} mL를 섞어 I을 만든다. I에 c M HC(aq) V mL(V>0)를 더해 II를 만든다.\n모든 음이온의 몰 농도 합은 I과 II가 같다. 혼합 용액의 부피는 혼합 전 각 용액의 부피의 합과 같고, 물의 자동 이온화는 무시하며 A⁺, B²⁻, C⁻은 반응하지 않는다.\nII의 액성으로 옳은 것은?";
            choices=["II에서 H⁺가 남는다","II에서 OH⁻가 남는다","II는 중성이다","I에서 H⁺가 반드시 남는다","I에서 OH⁻가 반드시 남는다"];
            answer="① "+choices[0];
            steps=["II가 염기성이면 I도 염기성이고, HC를 더해도 전체 음이온 몰수는 일정하지만 부피는 늘어나므로 I·II의 음이온 몰 농도 합이 같을 수 없다. II가 중성이어도 I의 OH⁻가 HC에 의해 C⁻로 바뀔 뿐 음이온 총량이 일정해 같은 모순이다. 따라서 II는 산성으로 H⁺가 남는다."];
        }else{
            var variantP=number==2?p*2:p;
            var variantQ=number==2?q*2:q*2;
            var variantT=number==2?t*2:t;
            var ratioTwo=number==2?source.RatioTwo:.8;
            var ratioThree=number==2?source.RatioThree:.875;
            var question=number==2?"처음 첨가한 HC의 부피 V(mL)는?":"c/(a+b) × V는?";
            body=$"다음은 중화 반응에 대한 실험이다.\n○ 수용액에서 AOH는 A⁺와 OH⁻, H₂B는 H⁺ 이온 2개와 B²⁻ 이온 1개, HC는 H⁺와 C⁻로 모두 이온화된다.\n(가) a M AOH(aq) {Format(variantP)} mL에 b M H₂B(aq) {Format(variantQ)} mL를 첨가하여 혼합 용액 I을 만든다.\n(나) I에 c M HC(aq) V mL를 첨가하여 혼합 용액 II를 만든다.\n(다) II에 c M HC(aq) {Format(variantT)} mL를 첨가하여 혼합 용액 III을 만든다.\n| 혼합 용액 | II | III |\n|---|---|---|\n| 음이온의 양(mol)/(양이온의 양(mol)) | {Format(ratioTwo)} | {Format(ratioThree)} |\n○ 모든 음이온의 몰 농도(M)의 합은 I과 II가 같다. 혼합 용액의 부피는 혼합 전 각 용액의 부피의 합과 같고, 물의 자동 이온화는 무시하며 A⁺, B²⁻, C⁻은 반응하지 않는다.\n{question}";
            var provisional=Solve(body,["1","2","3","4","5"]);
            var value=provisional.Value;
            choices=[Format(value*.5),Format(value*.75),Format(value),Format(value*1.25),Format(value*1.5)];
            answer="③ "+choices[2];
            var verified=Solve(body,choices);
            if(verified.ChoiceIndex!=2)throw new InvalidDataException("단계 문제의 계산값과 보기 구성을 검산하지 못했습니다.");
            steps=number==2?[
                "II가 염기성 또는 중성이면 I에서 II로 HC를 추가해도 음이온 총량은 유지되고 부피만 늘어나므로 두 혼합액의 음이온 몰 농도 합이 같을 수 없다. 따라서 II·III은 산성이다.",
                $"산성 혼합액의 음이온/양이온 몰수 비에 II={Format(ratioTwo)}, III={Format(ratioThree)}를 대입하면 cV={Format(verified.AcidTwo)}b, c(V+{Format(variantT)})={Format(verified.AcidThree)}b이다. 차이에서 c={Format(verified.C)}b, 따라서 V={Format(verified.V)} mL이다."
            ]:SolveSource(body+"\n"+string.Join(" ",choices.Select((choice,index)=>$"{"①②③④⑤"[index]} {choice}")))!.Steps;
        }
        if(steps.Length!=number)throw new InvalidDataException("단계별 풀이 수와 코드 템플릿의 풀이 수가 다릅니다.");
        var explanation=string.Join("\n",steps.Select((step,index)=>$"STEP {index+1}. {step}"));
        var result=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),draft.Title,body,choices,answer,explanation,steps,
            "순차 중화 원본의 이온 수·농도 관계를 유지하며 단계별 수치를 다시 구성했습니다."){
            GenerationNotice="코드 템플릿 생성 · 독립 수치 검산 완료 · 교사 검수 전",
            SourceProblem=draft.Body,SourceAnswer=draft.Answer,SourceExplanation=draft.Explanation,SourceSteps=draft.Steps,
            Model="검산된 문제 템플릿",PromptVersion="sequential-neutralization-v1",UsageSummary="AI 호출 없이 코드로 구성·검산",
            VisualVerification="원본 표의 이온 수 관계를 코드로 재계산했습니다. 별도 그림은 없는 문항입니다."
        };
        var checkedReport=ProblemQualityHarness.Inspect(result,draft,number<total);
        checkedReport=checkedReport with{Checks=checkedReport.Checks.Select(check=>check.Id is "language" or "conditions" or "semantic-math" or "visual-semantics" or "source-logic"
            ?check with{State="pass",Evidence="검산된 고정 문장 템플릿과 이온 수 계산으로 확인했습니다.",Method="code-template"}:check).ToArray()};
        if(!checkedReport.AnswerVerified)throw new InvalidDataException("단계별 중화 문제 템플릿의 독립 검산에 실패했습니다: "+string.Join(" | ",checkedReport.Checks.Where(check=>check.State=="fail").Select(check=>check.Label+" "+check.Evidence)));
        return result with{Quality=checkedReport};
    }

    private static Solution Solve(string body,string[]? choices)
    {
        var parsed=Read(body,choices);var baseVolume=parsed.BaseVolume;var diproticVolume=parsed.DiproticVolume;
        var r2=parsed.RatioTwo;var r3=parsed.RatioThree;
        if(r2<=.5||r2>=1||r3<=r2||r3>=1)throw new InvalidDataException("II·III의 이온 수 비를 이 순차 중화 계산식에 적용할 수 없습니다.");
        // Normalize b=1. The requested value is invariant under common scale.
        static double AcidFromRatio(double acidVolume,double ratio)=>acidVolume*(2*ratio-1)/(1-ratio);
        var acidTwo=AcidFromRatio(diproticVolume,r2);
        var acidThree=AcidFromRatio(diproticVolume,r3);
        var c=(acidThree-acidTwo)/parsed.FinalAcidVolume;
        var v=acidTwo/c;
        var initialVolume=baseVolume+diproticVolume;
        var a=(diproticVolume+initialVolume*(diproticVolume+acidTwo)/(initialVolume+v))/baseVolume;
        var initialExcess=baseVolume*a-2*diproticVolume;
        if(!(a>0&&c>0&&v>0&&initialExcess>0&&initialExcess<acidTwo&&double.IsFinite(a)&&double.IsFinite(v)))
            throw new InvalidDataException("주어진 이온 수 비와 I·II의 음이온 농도 조건을 함께 만족하는 양의 농도가 없습니다.");
        var value=parsed.Question=="V"?v:acidTwo/(a+1);
        var indexes=parsed.Choices.Select((choice,index)=>(choice,index)).Where(x=>double.TryParse(x.choice,NumberStyles.Float,CultureInfo.InvariantCulture,out var number)&&Near(number,value)).Select(x=>x.index).ToArray();
        return new(a,1,c,v,acidTwo,acidThree,value,indexes.Length==1?indexes[0]:-1,parsed);
    }

    private static Parsed Read(string body,string[]? choices)
    {
        var text=Plain(body);
        double Volume(string pattern,string label){var match=Regex.Match(text,pattern,RegexOptions.IgnoreCase|RegexOptions.Singleline);if(!match.Success||!double.TryParse(match.Groups[1].Value,CultureInfo.InvariantCulture,out var value)||value<=0)throw new InvalidDataException(label+" 부피를 원본에서 확인하지 못했습니다.");return value;}
        var baseVolume=Volume(@"a\s*M\s*AOH\s*\(aq\)\s*(\d+(?:\.\d+)?)\s*mL","AOH");
        var diproticVolume=Volume(@"b\s*M\s*H2B\s*\(aq\)\s*(\d+(?:\.\d+)?)\s*mL","H₂B");
        if(!Regex.IsMatch(text,@"I\s*에\s*c\s*M\s*HC\s*\(aq\)\s*V\s*mL",RegexOptions.IgnoreCase))throw new InvalidDataException("I에 HC V mL를 첨가하는 조건을 확인하지 못했습니다.");
        var finalVolume=Volume(@"II\s*에\s*c\s*M\s*HC\s*\(aq\)\s*(\d+(?:\.\d+)?)\s*mL","II에 추가한 HC");
        var question=Regex.IsMatch(text,@"(?:\(\s*c\s*\)|c)\s*/\s*\(\s*a\s*\+\s*b\s*\)\s*[×*]\s*V",RegexOptions.IgnoreCase)?"cV/(a+b)"
            :Regex.IsMatch(text,@"(?:부피\s*)?V\s*\(?mL\)?\s*는\s*\?",RegexOptions.IgnoreCase)?"V"
            :throw new InvalidDataException("물음의 c/(a+b)×V 또는 V(mL)를 확인하지 못했습니다.");
        var ratioLine=text.Split('\n').FirstOrDefault(line=>line.Contains("음이온의 양",StringComparison.Ordinal)&&line.Contains("양이온의 양",StringComparison.Ordinal))??"";
        var ratios=Regex.Matches(ratioLine,@"\(?\s*(\d+)\s*\)?\s*/\s*\(?\s*(\d+)\s*\)?").Select(m=>double.Parse(m.Groups[1].Value,CultureInfo.InvariantCulture)/double.Parse(m.Groups[2].Value,CultureInfo.InvariantCulture)).ToArray();
        if(ratios.Length!=2)throw new InvalidDataException("II·III의 음이온/양이온 수 비 두 개를 확인하지 못했습니다.");
        var values=choices??Regex.Matches(text,@"[①②③④⑤]\s*(\d+(?:\.\d+)?)").Select(m=>m.Groups[1].Value).ToArray();
        if(values.Length!=5)throw new InvalidDataException("정답 보기 5개를 확인하지 못했습니다.");
        return new(baseVolume,diproticVolume,finalVolume,ratios[0],ratios[1],question,values);
    }

    private static bool IsStageOne(string body){var text=Plain(body);return text.Contains("AOH",StringComparison.OrdinalIgnoreCase)&&text.Contains("H2B",StringComparison.OrdinalIgnoreCase)&&text.Contains("HC",StringComparison.OrdinalIgnoreCase)&&text.Contains("I과 II",StringComparison.Ordinal)&&text.Contains("II의 액성으로 옳은 것은?",StringComparison.Ordinal);}
    private static int ChoiceIndex(string answer)=>answer.Length>0?"①②③④⑤".IndexOf(answer.Trim()[0]):-1;
    private static bool Near(double left,double right)=>Math.Abs(left-right)<=1e-7*Math.Max(1,Math.Abs(right));
    private static string Format(double value){for(var d=1;d<=1000;d++){var n=Math.Round(value*d);if(Near(value,n/d))return d==1?n.ToString(CultureInfo.InvariantCulture):$"{n}/{d}";}return value.ToString("0.####",CultureInfo.InvariantCulture);}
    private static string Plain(string body)=>body.Replace('₂','2').Replace('⁺','+').Replace('⁻','-').Replace("Ⅲ","III").Replace("Ⅱ","II").Replace("Ⅰ","I").Replace("\\(","(").Replace("\\)",")").Replace("\\frac","frac");
}

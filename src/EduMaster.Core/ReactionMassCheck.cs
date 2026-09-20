using System.Globalization;
using System.Text.RegularExpressions;
namespace EduMaster.Core;

// Narrow MVP: A + bB -> 2C + 2D, three mass rows and relative D/total fractions.
// No question text, table values or answer are taken from a cached sample.
public sealed record ReactionMassSolution(double MassRatio,int B,double Scale,double X,double Value,string Answer,string[] Steps);
public static class ReactionMassCheck
{
    // Keep annotation text in the visible source, but do not treat handwriting
    // commentary inside a table cell as a printed numerical condition.
    private static string CalculationText(string text)=>Regex.Replace(LocalVisionReader.NormalizeMath(text),@"\[주석[^\]\r\n]*\]", "");
    public static string NormalizeSupportedOcr(string text)
    {
        text=LocalVisionReader.NormalizeMath(text);
        var compact=Regex.Replace(text,@"\s","");
        if(!compact.Contains("A(g)+bB(g)→2C(g)+2D(g)")||!compact.Contains("b/x")||!compact.Contains("전체기체"))return text;
        text=Regex.Replace(text,
            @"\(C의\s*질량\s*\+\s*D의\s*질량\)\s*/\s*\(B의\s*질량\)",
            "(C의 몰질량 + D의 몰질량)/(B의 몰질량)");
        // A worked-solution image often has the calculated x value handwritten in the
        // original problem table. It is evidence for checking, not a condition students
        // should receive in the reconstructed question.
        return Regex.Replace(text,@"(?<=\|)\s*x\s*=\s*[-+]?\d+(?:\s*/\s*\d+)?\s*(?=\|)"," x ",RegexOptions.IgnoreCase);
    }
    public static string RepairMolarMassOcr(string text)=>Regex.Replace(text,
        @"\(C의\s*물질량\s*\+\s*D의\s*물질량\)\s*/\s*\(?B의\s*물질량\)?",
        "(C의 몰질량 + D의 몰질량)/(B의 몰질량)");
    public static bool NeedsQuantityReview(string text)
    {
        var compact=Regex.Replace(CalculationText(text),@"[\s()]","");
        return compact.Contains("Ag+bBg→2Cg+2Dg")&&compact.Contains("전체기체")&&CalculationText(text).Split('\n').Any(line=>Regex.Replace(line,@"[\s()]","").Contains("b/x")&&Regex.Replace(line,@"\s","").Contains("물질량"));
    }
    public static string UniformMassVariantBody(string original,int factor=2,bool hideRemaining=false)
    {
        if(factor is <2 or >5)throw new ArgumentOutOfRangeException(nameof(factor));
        _=Solve(original)??throw new InvalidDataException("반응량 기준 표를 검산하지 못했습니다.");
        var rows=CalculationText(original).Split('\n').Select(l=>l.Split('|',StringSplitOptions.TrimEntries|StringSplitOptions.RemoveEmptyEntries)).Where(c=>c.Length==5&&Regex.IsMatch(c[0],@"^(I|II|III|Ⅰ|Ⅱ|Ⅲ)$")).ToArray();
        var result=new List<string>{"다음 반응을 완결시킨 실험 I~III의 자료이다.","A(g) + bB(g) → 2C(g) + 2D(g) (b는 반응 계수)",
            $"w는 양의 질량 상수이다. 상댓값은 D의 몰분율에 모든 실험에 공통인 양의 상수 k를 곱한 값이며, x는 실험 {rows.First(r=>Regex.Replace(r[4],@"\s","").StartsWith('x'))[0]}의 상댓값이다.",
            "| 실험 | 반응 전 A의 질량(g) | 반응 전 B의 질량(g) | 반응 후 남은 A 또는 B의 질량(g) | D의 양(mol)/전체 기체의 양(mol) (상댓값) |","|---|---|---|---|---|"};
        foreach(var row in rows){
            var rest=Regex.Replace(row[3],@"\s","");var relative=Regex.Replace(row[4],@"\s","");
            var match=Regex.Match(rest,@"^([AB])?(.*)w$");
            var label=hideRemaining?"":match.Groups[1].Value+" ";
            result.Add($"| {row[0]} | {Fraction(factor*Number(row[1]))}w | {Fraction(factor*Number(row[2]))}w | {label}({Fraction(factor*Number(match.Groups[2].Value))})w | {(relative.StartsWith('x')?"x":relative)} |");
        }
        result.Add("(b/x) × (C의 몰질량 + D의 몰질량)/(B의 몰질량)은? (단, 실린더 속 기체의 온도와 압력은 일정하다.)");
        return string.Join("\n",result);
    }
    private sealed record Row(double A,double B,char Remaining,double Rest,string Relative)
    { public double ReactedA=>Remaining=='A'?A-Rest:A; }
    public static QualityCheck? InspectMassConditions(string text)
    {
        text=CalculationText(text);var compact=Regex.Replace(text,@"\s","");
        if(!compact.Contains("A(g)+bB(g)→2C(g)+2D(g)")||!compact.Contains("반응전")||!compact.Contains("반응후")||!compact.Contains("질량")||!text.Contains('|'))return null;
        try{
            var rows=ReadRows(text);_ = ConsumedMassRatio(rows);
            return new("reaction-conditions","반응 표의 질량 조건","pass","지원 반응식의 실험 3개: 초기·잔류 질량, 양의 소비량과 공통 소비 질량비 대조. 질문의 정답 검산과는 별도입니다.","code");
        }catch(InvalidDataException e){return new("reaction-conditions","반응 표의 질량 조건","fail",e.Message,"code");}
    }
    private static List<Row> ReadRows(string text)
    {
        var rows=new List<Row>();
        foreach(var line in text.Split('\n')){
            var cells=line.Split('|',StringSplitOptions.TrimEntries|StringSplitOptions.RemoveEmptyEntries);
            if(cells.Length!=5||!Regex.IsMatch(cells[0],@"^(I|II|III|Ⅰ|Ⅱ|Ⅲ)$"))continue;
            var rest=Regex.Match(Regex.Replace(cells[3],@"\s", ""),@"^([AB])?(.*)w$");
            if(!rest.Success)throw new InvalidDataException("반응 후 남은 기체 A/B와 질량을 확인해 주세요.");
            rows.Add(new(Number(cells[1]),Number(cells[2]),rest.Groups[1].Success?rest.Groups[1].Value[0]:'?',Number(rest.Groups[2].Value),Regex.Replace(cells[4],@"\s", "")));
        }
        if(rows.Count!=3)throw new InvalidDataException("반응량 표의 실험 I~III, 질량과 상대 몰비를 확인해 주세요.");
        if(rows.Any(r=>r.Remaining=='?')){
            var candidates=new List<List<Row>>();
            for(var mask=0;mask<8;mask++){
                var candidate=rows.Select((r,i)=>r.Remaining=='?'?r with{Remaining=(mask&(1<<i))==0?'A':'B'}:r).ToList();
                try{_=ConsumedMassRatio(candidate);if(!candidates.Any(c=>c.Select(r=>r.Remaining).SequenceEqual(candidate.Select(r=>r.Remaining))))candidates.Add(candidate);}catch(InvalidDataException){}
            }
            if(candidates.Count!=1)throw new InvalidDataException("실험별 남은 기체가 하나로 결정되지 않습니다. 초기·잔류 질량과 반응 조건을 확인해 주세요.");
            return candidates[0];
        }
        return rows;
    }
    private static double ConsumedMassRatio(List<Row> rows)
    {
        for(var i=0;i<rows.Count;i++){
            var r=rows[i];var initial=r.Remaining=='A'?r.A:r.B;
            if(r.A<=0||r.B<=0||r.Rest<=0||r.Rest>=initial)
                throw new InvalidDataException(FormattableString.Invariant($"실험 {i+1}: 초기 {r.Remaining} 질량 {initial:G8}w, 잔류 질량 {r.Rest:G8}w입니다. 양의 반응 소비량과 초기 질량보다 작은 잔류량 조건을 만족하지 않습니다."));
        }
        var ratios=rows.Select(r=>(r.Remaining=='B'?r.B-r.Rest:r.B)/r.ReactedA).ToArray();
        if(ratios.Any(r=>!double.IsFinite(r)||r<=0)||ratios.Any(r=>Math.Abs(r-ratios[0])>1e-7))
            throw new InvalidDataException("실험별 B/A 소비 질량비가 다릅니다. 표의 세 실험이 같은 반응을 만족하지 않습니다.");
        return ratios[0];
    }
    public static ReactionMassSolution? Solve(string text)
    {
        text=CalculationText(text);var compact=Regex.Replace(text,@"\s","");
        var hasQuestion=text.Split('\n').Any(line=>Regex.IsMatch(Regex.Replace(line,@"[\s()]", ""),@"b/x×(?:M_C\+M_D/M_B|C의몰질량\+D의몰질량/B의몰질량)(?:은|는)?\?"));
        if(!compact.Contains("A(g)+bB(g)→2C(g)+2D(g)")||!compact.Contains("몰질량")||!hasQuestion||
            !compact.Contains("전체기체")||!(compact.Contains("상댓값")||compact.Contains("상대값")))return null;
        var rows=ReadRows(text);var ratio=ConsumedMassRatio(rows);var knownA=rows.FirstOrDefault(r=>r.Remaining=='A'&&!r.Relative.StartsWith('x'));
        var knownB=rows.FirstOrDefault(r=>r.Remaining=='B'&&!r.Relative.StartsWith('x'));
        var unknown=rows.SingleOrDefault(r=>r.Relative.StartsWith('x'));
        if(knownA is null||knownB is null||unknown is null)throw new InvalidDataException("A가 남는 실험과 B가 남는 실험의 상대 몰비, 미지수 x를 확인해 주세요.");
        var scale=Number(knownA.Relative)*(knownA.Rest+4*knownA.ReactedA)/(2*knownA.ReactedA);
        var bValue=(scale*2*knownB.ReactedA/Number(knownB.Relative)-4*knownB.ReactedA)*ratio/knownB.Rest;
        var b=(int)Math.Round(bValue);
        if(!double.IsFinite(bValue)||b<=0||b>100||Math.Abs(bValue-b)>1e-7)throw new InvalidDataException("상대 몰비로 구한 반응계수가 양의 정수가 아닙니다. 표의 수치를 확인해 주세요.");
        var x=scale*2*unknown.ReactedA/((unknown.Remaining=='A'?unknown.Rest:unknown.Rest*b/ratio)+4*unknown.ReactedA);
        if(unknown.Relative.Contains('=')){var supplied=Number(unknown.Relative.Split('=')[1]);if(Math.Abs(supplied-x)>1e-7)throw new InvalidDataException("필기된 x 값이 표에서 계산한 값과 다릅니다. 원문 조건을 확인해 주세요.");}
        var sum=(b/ratio+b)/2;var value=b/x*sum;var answer=Fraction(value);
        var proof=rows.Take(2).All(r=>r.Remaining=='A'&&r.B>r.Rest)
            ?$"실험 I·II에서 A가 모두 반응했다고 가정하면 B/A 소비 질량비가 각각 {Fraction((rows[0].B-rows[0].Rest)/rows[0].A)}, {Fraction((rows[1].B-rows[1].Rest)/rows[1].A)}로 달라 모순이다. 따라서 두 실험에서는 B가 모두 반응한다. "
            :"남은 기체의 가능한 A/B 조합을 초기·잔류 질량과 공통 소비 질량비로 대조한다. ";
        var after=string.Join("; ",rows.Select((r,i)=>$"실험 {i+1}: "+(r.Remaining=='A'?$"A {Fraction(r.Rest)}w, B 0":$"A 0, B {Fraction(r.Rest)}w")+$", C+D {Fraction(r.A+r.B-r.Rest)}w"));
        return new(ratio,b,scale,x,value,answer,[
            $"STEP 1 · 한계 반응물: {proof}실험 I~III에 남는 기체는 {string.Join(", ",rows.Select(r=>r.Remaining))}이며 B/A 소비 질량비는 {Fraction(ratio)}이다.",
            $"STEP 2 · 반응 후 질량·몰수: 질량 보존으로 {after}. A가 t mol 반응하면 C와 D는 각각 2t mol 생성된다. 계수비는 몰수비이므로 M_A/M_B = b/{Fraction(ratio)}이다.",
            $"STEP 3 · 상대 몰비·몰질량: A가 남는 실험 {new[]{"Ⅰ","Ⅱ","Ⅲ"}[rows.IndexOf(knownA)]}의 D/전체 = {Fraction(2*knownA.ReactedA/(knownA.Rest+4*knownA.ReactedA))}이므로 공통 상댓값 배율 k = {Fraction(scale)}. B가 남는 실험 {new[]{"Ⅰ","Ⅱ","Ⅲ"}[rows.IndexOf(knownB)]}의 전체 몰수에 남은 B도 포함하면 b = {b}, 미지수 실험 {new[]{"Ⅰ","Ⅱ","Ⅲ"}[rows.IndexOf(unknown)]}에서 x = {Fraction(x)}이다. 질량 보존: (M_C+M_D)/M_B = (M_A/M_B+b)/2 = {Fraction(sum)}. 따라서 ({b}/{Fraction(x)}) × {Fraction(sum)} = {answer}."
        ]);
    }
    public static SampleResult Verify(SampleResult result)
    {
        var solved=Solve(result.Body)??throw new InvalidDataException("반응량 계산 유형이 변경됐습니다. 같은 반응식·표·몰질량 질문으로 다시 생성해 주세요.");
        var matches=result.Choices.Select((c,i)=>(c,i)).Where(p=>Math.Abs(Number(p.c)-solved.Value)<1e-7).ToArray();
        if(matches.Length!=1)throw new InvalidDataException("검산한 정답과 보기가 일치하지 않습니다. 다시 생성해 주세요.");
        return result with{Answer=new[]{"①","②","③","④","⑤"}[matches[0].i]+" "+result.Choices[matches[0].i],
            Explanation=string.Join("\n",solved.Steps),Steps=solved.Steps,
            GenerationNotice="AI 문항 초안 + 반응량 표·상대 몰비·정답 계산 검증 · 교사 확인 전"};
    }
    public static void VerifyUniformMassScale(string original,string variant)
    {
        static string[][] Rows(string text)=>CalculationText(text).Split('\n').Select(l=>l.Split('|',StringSplitOptions.TrimEntries|StringSplitOptions.RemoveEmptyEntries)).Where(c=>c.Length==5&&Regex.IsMatch(c[0],@"^(I|II|III|Ⅰ|Ⅱ|Ⅲ)$")).ToArray();
        var source=Rows(original);var result=Rows(variant);
        if(source.Length!=3||result.Length!=3)throw new InvalidDataException("원본과 변형 표의 실험 행을 확인하지 못했습니다.");
        for(var i=0;i<3;i++){
            for(var c=1;c<=3;c++){
                var before=Regex.Replace(source[i][c],@"\s","");var after=Regex.Replace(result[i][c],@"\s","");
                if(c==3){if(before[0]!=after[0])throw new InvalidDataException("남은 기체가 원본과 달라졌습니다.");before=before[1..];after=after[1..];}
                if(Math.Abs(Number(after)-2*Number(before))>1e-7)throw new InvalidDataException("첫 MVP는 모든 질량을 같은 2배로 변형합니다. 표 수치가 맞지 않아 중단했습니다.");
            }
            var beforeRelative=Regex.Replace(source[i][4],@"\s","");var afterRelative=Regex.Replace(result[i][4],@"\s","");
            if(beforeRelative.StartsWith('x'))beforeRelative="x";
            if(beforeRelative!=afterRelative)throw new InvalidDataException("상대 몰비와 미지수 x는 질량과 함께 배로 바꾸거나 정답을 미리 줄 수 없습니다. 잘못 변형되어 중단했습니다.");
        }
    }
    private static double Number(string text)
    {
        text=Regex.Replace(text,@"[\s()w]", "");if(text=="")return 1;
        var pieces=text.Split('/');
        if(pieces.Length>2||!double.TryParse(pieces[0],NumberStyles.Number,CultureInfo.InvariantCulture,out var n)||!double.IsFinite(n)||n<0||n>1e6)
            throw new InvalidDataException("질량·상대 몰비의 숫자 또는 분수를 확인해 주세요.");
        if(pieces.Length==2){if(!double.TryParse(pieces[1],NumberStyles.Number,CultureInfo.InvariantCulture,out var d)||d<=0||d>1e6)throw new InvalidDataException("분수의 분모를 확인해 주세요.");n/=d;}
        return n;
    }
    private static string Fraction(double value)
    {
        if(!double.IsFinite(value)||value<=0||value>1e6)throw new InvalidDataException("반응량 계산 범위를 벗어났습니다.");
        for(var d=1;d<=10000;d++){var n=Math.Round(value*d);if(Math.Abs(n/d-value)<1e-9)return d==1?n.ToString(CultureInfo.InvariantCulture):$"{n.ToString(CultureInfo.InvariantCulture)}/{d}";}
        return value.ToString("0.########",CultureInfo.InvariantCulture);
    }
    public static void VerifySameLogicVariant(string original,string variant)
    {
        var source=ReadRows(CalculationText(original));var target=ReadRows(CalculationText(variant));
        var factor=target[0].A/source[0].A;
        if(!double.IsFinite(factor)||factor<=0||Math.Abs(factor-1)<1e-7)throw new InvalidDataException("쌍둥이 문제의 질량 수치가 변형되지 않았습니다.");
        for(var i=0;i<3;i++){
            if(source[i].Remaining!=target[i].Remaining)throw new InvalidDataException("실험별 한계 반응물과 잔류 물질 순서가 원본과 달라졌습니다.");
            foreach(var pair in new[]{(source[i].A,target[i].A),(source[i].B,target[i].B),(source[i].Rest,target[i].Rest)})
                if(Math.Abs(pair.Item2-factor*pair.Item1)>1e-7)throw new InvalidDataException("반응 전·후 질량이 모든 실험에서 같은 배율로 변형되지 않았습니다.");
            static string Relative(string value)=>value.StartsWith('x')?"x":value;
            if(Relative(source[i].Relative)!=Relative(target[i].Relative))throw new InvalidDataException("상댓값과 미지수 x의 배치가 원본과 달라졌습니다.");
        }
        var before=Solve(original)??throw new InvalidDataException("원본 반응량 풀이 구조를 확인하지 못했습니다.");
        var after=Solve(variant)??throw new InvalidDataException("변형 반응량 풀이 구조를 확인하지 못했습니다.");
        if(before.B!=after.B||Math.Abs(before.X-after.X)>1e-7||Math.Abs(before.Value-after.Value)>1e-7||Math.Abs(before.MassRatio-after.MassRatio)>1e-7)
            throw new InvalidDataException("반응계수·상댓값·몰질량 계산 관계가 원본과 달라졌습니다.");
    }
    public static string FormatValue(double value)=>Fraction(value);
    public static bool ReferenceAnswerMatches(string answer,ReactionMassSolution solution)
    {
        answer=Regex.Replace(LocalVisionReader.NormalizeMath(answer),@"^(?:정답\s*[:：]?\s*)?[①②③④⑤]\s*","");
        return Math.Abs(Number(answer)-solution.Value)<1e-7;
    }
}

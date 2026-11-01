// Extracts the table-driven test cases of abr-geocoder (normalize, transform and
// matching/issues) into JSON, so the TypeScript port can run the same cases.
//
//	go run ./upstream/extract <abr-geocoder checkout> > upstream/cases.json
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

var dirs = []string{"normalize", "transform", "matching/issues"}

type table struct {
	File string `json:"file"`
	Func string `json:"func"`
	// Call is the function the test runs on each case (e.g. AddressNumbersToHyphen),
	// Args the case fields it passes. Empty when the test calls a helper.
	Call  string   `json:"call,omitempty"`
	Args  []string `json:"args,omitempty"`
	Cases []any    `json:"cases"`
}

type evaluator struct {
	src    []byte
	fset   *token.FileSet
	consts map[string]any
}

// collectConsts reads string constants of a package so idents such as
// model.MatchLevelParcel or FieldPref turn into their values.
func collectConsts(fset *token.FileSet, dir, prefix string, into map[string]any) {
	files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
	for _, path := range files {
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			continue
		}
		for _, decl := range f.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.CONST {
				continue
			}
			for _, spec := range gen.Specs {
				vs := spec.(*ast.ValueSpec)
				for i, name := range vs.Names {
					if i >= len(vs.Values) {
						continue
					}
					if lit, ok := vs.Values[i].(*ast.BasicLit); ok {
						switch lit.Kind {
						case token.STRING:
							into[prefix+name.Name], _ = strconv.Unquote(lit.Value)
						case token.INT:
							into[prefix+name.Name], _ = strconv.Atoi(lit.Value)
						}
					}
				}
			}
		}
	}
}

func (e *evaluator) text(n ast.Node) string {
	return string(e.src[e.fset.Position(n.Pos()).Offset:e.fset.Position(n.End()).Offset])
}

func (e *evaluator) value(x ast.Expr) any {
	switch v := x.(type) {
	case *ast.BasicLit:
		switch v.Kind {
		case token.STRING:
			s, _ := strconv.Unquote(v.Value)
			return s
		case token.INT:
			n, _ := strconv.Atoi(v.Value)
			return n
		}
	case *ast.Ident:
		switch v.Name {
		case "true":
			return true
		case "false":
			return false
		case "nil":
			return nil
		}
		if c, ok := e.consts[v.Name]; ok {
			return c
		}
	case *ast.SelectorExpr:
		if pkg, ok := v.X.(*ast.Ident); ok {
			if c, ok := e.consts[pkg.Name+"."+v.Sel.Name]; ok {
				return c
			}
		}
	case *ast.UnaryExpr:
		if v.Op == token.AND {
			return e.value(v.X)
		}
	case *ast.BinaryExpr:
		if v.Op == token.ADD {
			l, r := e.value(v.X), e.value(v.Y)
			if ls, ok := l.(string); ok {
				if rs, ok := r.(string); ok {
					return ls + rs
				}
			}
			if li, ok := l.(int); ok {
				if ri, ok := r.(int); ok {
					return li + ri
				}
			}
		}
	case *ast.CallExpr:
		if sel, ok := v.Fun.(*ast.SelectorExpr); ok && e.text(sel) == "strings.Repeat" && len(v.Args) == 2 {
			str, ok1 := e.value(v.Args[0]).(string)
			n, ok2 := e.value(v.Args[1]).(int)
			if ok1 && ok2 {
				return strings.Repeat(str, n)
			}
		}
		// ptr("x") and similar one-argument helpers
		if len(v.Args) == 1 {
			return e.value(v.Args[0])
		}
	case *ast.CompositeLit:
		if len(v.Elts) > 0 {
			if _, keyed := v.Elts[0].(*ast.KeyValueExpr); keyed {
				obj := map[string]any{}
				for _, el := range v.Elts {
					kv := el.(*ast.KeyValueExpr)
					key, ok := e.value(kv.Key).(string)
					if !ok {
						key = e.text(kv.Key)
					}
					obj[key] = e.value(kv.Value)
				}
				return obj
			}
		}
		arr := []any{}
		for _, el := range v.Elts {
			arr = append(arr, e.value(el))
		}
		return arr
	}
	return map[string]any{"$expr": e.text(x)}
}

// fieldNames lists the fields of a []struct{...} table, for cases written without keys.
func fieldNames(lit *ast.CompositeLit) []string {
	st, ok := lit.Type.(*ast.ArrayType).Elt.(*ast.StructType)
	if !ok {
		return nil
	}
	names := []string{}
	for _, f := range st.Fields.List {
		for _, n := range f.Names {
			names = append(names, n.Name)
		}
	}
	return names
}

// callUnderTest finds the first call in fn that passes a field of the loop
// variable (tt.input, tc.address), and returns its name and those fields.
func callUnderTest(fn *ast.FuncDecl) (name string, args []string) {
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || name != "" {
			return name == ""
		}
		fields := []string{}
		for _, a := range call.Args {
			if sel, ok := a.(*ast.SelectorExpr); ok {
				if x, ok := sel.X.(*ast.Ident); ok && (x.Name == "tt" || x.Name == "tc") {
					fields = append(fields, sel.Sel.Name)
				}
			}
		}
		if len(fields) == 0 {
			return true
		}
		switch f := call.Fun.(type) {
		case *ast.Ident:
			name = f.Name
		case *ast.SelectorExpr:
			if x, ok := f.X.(*ast.Ident); ok && x.Name == "t" {
				return true // t.Run(tt.name, ...)
			}
			name = f.Sel.Name
		}
		args = fields
		return false
	})
	return name, args
}

// isTable reports whether lit is []struct{...}{...} or []someTestCase{...}.
func isTable(lit *ast.CompositeLit) bool {
	at, ok := lit.Type.(*ast.ArrayType)
	if !ok || len(lit.Elts) == 0 {
		return false
	}
	switch t := at.Elt.(type) {
	case *ast.StructType:
		return true
	case *ast.Ident:
		return strings.HasSuffix(t.Name, "TestCase") || strings.HasSuffix(t.Name, "Case")
	}
	return false
}

func main() {
	root := filepath.Join(os.Args[1], "abrg", "internal")
	fset := token.NewFileSet()
	consts := map[string]any{}
	collectConsts(fset, filepath.Join(root, "model"), "model.", consts)
	tables := []table{}
	for _, dir := range dirs {
		collectConsts(fset, filepath.Join(root, dir), "", consts)
		files, _ := filepath.Glob(filepath.Join(root, dir, "*_test.go"))
		sort.Strings(files)
		for _, path := range files {
			src, _ := os.ReadFile(path)
			f, err := parser.ParseFile(fset, path, src, 0)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			e := &evaluator{src: src, fset: fset, consts: consts}
			rel, _ := filepath.Rel(root, path)
			for _, decl := range f.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || !strings.HasPrefix(fn.Name.Name, "Test") {
					continue
				}
				ast.Inspect(fn, func(n ast.Node) bool {
					lit, ok := n.(*ast.CompositeLit)
					if !ok || !isTable(lit) {
						return true
					}
					names := fieldNames(lit)
					cases := []any{}
					for _, el := range lit.Elts {
						v := e.value(el)
						if arr, ok := v.([]any); ok && len(arr) == len(names) {
							obj := map[string]any{}
							for i, n := range names {
								obj[n] = arr[i]
							}
							v = obj
						}
						cases = append(cases, v)
					}
					call, args := callUnderTest(fn)
					tables = append(tables, table{File: rel, Func: fn.Name.Name, Call: call, Args: args, Cases: cases})
					return false
				})
			}
		}
	}
	out := json.NewEncoder(os.Stdout)
	out.SetEscapeHTML(false)
	out.SetIndent("", "  ")
	_ = out.Encode(tables)
}
